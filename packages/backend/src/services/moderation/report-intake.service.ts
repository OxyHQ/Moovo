/**
 * Storing a report and, when there is somewhere to send it, the promise to
 * deliver it — in one operation.
 *
 * This is the only thing in the integration that a user waits for. A 201 from
 * `POST /reports` means the report row and its outbox event committed together.
 * It does NOT mean CrowdSource accepted anything — CrowdSource may be
 * unreachable, mid-deploy or not yet configured, and the reporter is told their
 * report was received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one would give two
 * failure modes that are both silent: a report with no delivery event (the report
 * exists, nothing will ever send it, and nobody finds out until somebody asks why
 * a case never opened) or a delivery event with no report (a delivery worker
 * looking up an id that was rolled back). Neither surfaces as an error at the
 * moment it happens, which is exactly why this has to be atomic rather than
 * carefully ordered.
 *
 * The one report with NO delivery event is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but
 * "there was never a route out of this application for this kind of object".
 * Those two must not be conflated, which is why they are different `localStatus`
 * values and why the absent route is written down as a reason rather than
 * inferred from a missing row.
 */

import { isLiveEntityId } from '@oxyhq/db';
import mongoose, { type ClientSession } from 'mongoose';
import {
  REPORTED_TYPES,
  type ModerationLocalStatus,
  type ReportCategory,
  type ReportedType,
} from '@moovo/shared-types';
import { Report, type IReport } from '../../models/report.js';
import { Job } from '../../models/job.js';
import {
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from './moderation-outbox.service.js';
import { subjectProviderFor } from './subjects/registry.js';

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

/**
 * Refuses an identifier that is not a string, at the point the QUERY is built.
 *
 * `CreateReportInput` types these as strings and the route validates them, but a
 * type is erased at runtime and a truthiness check passes `{ $ne: null }`. Handed
 * that, `findOne` matches an UNRELATED report and this function answers "you
 * already reported this" about somebody else's row — and `Report.create` would
 * then store a query operator where an id belongs.
 *
 * The check lives here rather than only at the route because `createReport` is
 * exported: a queue worker, a backfill script or a future admin path is under no
 * obligation to have passed the route's validation, and a guard that exists at
 * one caller is a guard that holds until the second one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`createReport: '${field}' must be a non-empty string.`);
  }
  return value;
}

/**
 * The same guard for the reported type, which must also be one Moovo knows.
 *
 * Narrowing to `ReportedType` rather than returning `string` is not a typing
 * nicety: a value that reached the model as a bare string would be written
 * against the schema enum and rejected by Mongo at write time — after the
 * transaction had already opened — instead of here, where the caller is told
 * which field is wrong.
 */
function requireReportedType(value: unknown): ReportedType {
  const candidate = requireIdentifier(value, 'reportedType');
  const known = REPORTED_TYPES.find((type) => type === candidate);
  if (known === undefined) {
    throw new TypeError(`createReport: reportedType '${candidate}' is not a reportable type.`);
  }
  return known;
}

export interface CreateReportInput {
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
  contextJobId?: string;
}

export interface CreateReportResult {
  report: IReport;
  /**
   * The durable delivery event.
   *
   * Absent exactly when the reported type has no subject provider — the report
   * was stored and there is nothing to deliver it, by design rather than by
   * failure.
   */
  outboxEventId?: string;
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored on the row rather than left to be inferred from a missing outbox event.
 * A missing row is also what a lost write looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at
 * the time. Bounded by the schema's 300-character limit.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `Moovo has no moderation subject provider for '${reportedType}', so this report ` +
    'is recorded locally and is not sent for community review.'
  );
}

/**
 * The delivery a report may carry as context — but ONLY if the reporter was
 * there.
 *
 * This is the guard that keeps a context id from becoming an exfiltration
 * primitive. `contextJobId` arrives from the client, and a delivery description
 * (however redacted) is another customer's business: item description, delivery
 * instructions, coarse areas, timings. Without this check, anyone could report
 * any account, attach any job id, and have Moovo package a stranger's delivery
 * into a case for a jury to read — a textbook IDOR, with the twist that the
 * leaked data is pushed to third parties rather than returned in the response,
 * so it would never show up in the reporter's own traffic.
 *
 * A party is the sender or the assigned courier. Anything else — a job that does
 * not exist, a job the reporter had nothing to do with, a malformed id — yields
 * `undefined` and the report is stored without context. Deliberately silent: the
 * report is still valid and still delivered, and a 403 here would tell a prober
 * which job ids exist.
 */
async function resolveContextJobId(
  reporter: string,
  contextJobId: string | undefined,
): Promise<string | undefined> {
  if (contextJobId === undefined) return undefined;
  if (!isLiveEntityId(contextJobId)) return undefined;

  const job = await Job.findOne({
    _id: contextJobId,
    $or: [{ senderOxyUserId: reporter }, { courierOxyUserId: reporter }],
  })
    .select('_id')
    .lean<{ _id: mongoose.Types.ObjectId } | null>();

  return job ? contextJobId : undefined;
}

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    }, TRANSACTION_OPTIONS);
    if (result === undefined) {
      throw new Error('Report intake transaction completed without a result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject
 * provider. A type without one is stored at `received` with the reason recorded,
 * which is the behaviour the application had before CrowdSource existed: the
 * report is a receipt and a local record, and nothing else ever happens to it.
 *
 * That branch is the reason the two writes stay in one transaction rather than
 * being ordered carefully. The condition is read BEFORE the transaction body
 * decides anything, so `localStatus` and the presence of an outbox row are
 * decided together from one fact — a report can never commit as `queued` with
 * nothing to deliver it, nor as `received` with a delivery event that will try
 * anyway.
 *
 * Intake deliberately does not read `CROWDSOURCE_ENABLED`. A report taken while
 * the integration is off still gets its delivery event, so turning the flag on
 * delivers the backlog instead of stranding it — the dispatcher is what is gated,
 * not the durable record. Nothing here is conditional on a third party's state;
 * only on whether this application knows how to describe the object at all.
 */
export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  const reporter = requireIdentifier(input.reporter, 'reporter');
  const reportedId = requireIdentifier(input.reportedId, 'reportedId');
  const reportedType = requireReportedType(input.reportedType);

  const deliverable = subjectProviderFor(reportedType) !== undefined;
  const localStatus: ModerationLocalStatus = deliverable ? 'queued' : 'received';

  /**
   * Resolved BEFORE the transaction, deliberately.
   *
   * It is a read against a collection the transaction does not write, and doing
   * it inside would hold a snapshot-read transaction open across an ownership
   * lookup for no benefit. It also keeps the transaction body to exactly the two
   * writes whose atomicity is the point.
   */
  const contextJobId = await resolveContextJobId(reporter, input.contextJobId);

  return await inTransaction(async (session) => {
    const created = await Report.create(
      [
        {
          reporter,
          reportedType,
          reportedId,
          ...(contextJobId === undefined ? {} : { contextJobId }),
          categories: input.categories,
          ...(input.details === undefined ? {} : { details: input.details }),
          status: 'pending' as const,
          localStatus,
          ...(deliverable ? {} : { localStatusReason: localOnlyReason(reportedType) }),
        },
      ],
      { session },
    );
    const report = created[0];
    if (report === undefined) {
      throw new Error('Report.create returned no document');
    }

    if (!deliverable) return { report };

    const outboxEventId = await enqueueModerationOutboxEvent(
      {
        eventId: reportSubmitEventId(String(report._id)),
        kind: 'report.submit',
        payload: { reportId: String(report._id) },
      },
      session,
    );

    return { report, outboxEventId };
  });
}

/** Whether a thrown error is the unique-index rejection of a duplicate report. */
export function isDuplicateReportError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

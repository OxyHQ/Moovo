/**
 * Every statement this service issues against `reports`.
 *
 * A report carries TWO status axes and they are not redundant: `status` is what
 * Moovo concluded, `localStatus` is where the report stands in the delivery
 * pipeline. "A jury has it" is not "Moovo decided", and collapsing them loses
 * one of the two.
 *
 * ## `decisionRevision` starts working here, and it never has before
 *
 * `IReport` declares it and the decision worker writes it, but `ReportSchema`
 * declares no such path — so Mongoose's strict mode stripped it from every
 * `$set`, the column was never stored, and the `{decisionRevision: {$lt: n}}`
 * arm of the guard could never match. The guard against applying a LATE
 * delivery of an EARLIER revision has therefore never held in production.
 *
 * Storing the column makes it real, which is a behaviour CHANGE and not a
 * faithful port: a replayed older decision that would previously have been
 * applied is now refused. That is the behaviour the code always intended and
 * the reason it is called out here rather than left to read as a no-op.
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { reports } from '../schema/moderation';

/** A report, in the shape its consumers read. */
export interface ReportRecord {
  id: string;
  reporter: string;
  reportedType: string;
  reportedId: string;
  contextJobId?: string;
  categories: string[];
  details?: string;
  status: string;
  localStatus: string;
  localStatusReason?: string;
  lastDeliveryError?: string;
  contentSnapshotHash?: string;
  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  decisionRevision?: number;
  submittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** What creating a report needs — the caller supplies no id and no timestamps. */
export interface NewReport {
  reporter: string;
  reportedType: string;
  reportedId: string;
  contextJobId?: string | undefined;
  categories: string[];
  details?: string | undefined;
  status: string;
  localStatus: string;
  localStatusReason?: string | undefined;
}

type ReportRow = typeof reports.$inferSelect;

function toRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    reporter: row.reporter,
    reportedType: row.reportedType,
    reportedId: row.reportedId,
    ...(row.contextJobId === null ? {} : { contextJobId: row.contextJobId }),
    categories: row.categories,
    ...(row.details === null ? {} : { details: row.details }),
    status: row.status,
    localStatus: row.localStatus,
    ...(row.localStatusReason === null ? {} : { localStatusReason: row.localStatusReason }),
    ...(row.lastDeliveryError === null ? {} : { lastDeliveryError: row.lastDeliveryError }),
    ...(row.contentSnapshotHash === null ? {} : { contentSnapshotHash: row.contentSnapshotHash }),
    ...(row.crowdSourceReportId === null ? {} : { crowdSourceReportId: row.crowdSourceReportId }),
    ...(row.crowdSourceCaseId === null ? {} : { crowdSourceCaseId: row.crowdSourceCaseId }),
    ...(row.crowdSourceMerged === null ? {} : { crowdSourceMerged: row.crowdSourceMerged }),
    ...(row.decisionRevision === null ? {} : { decisionRevision: row.decisionRevision }),
    ...(row.submittedAt === null ? {} : { submittedAt: row.submittedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Store a report.
 *
 * Takes a handle rather than defaulting, because intake writes this row and its
 * outbox row in ONE transaction — a report answered 201 with no promise to
 * deliver it is the failure the outbox exists to prevent.
 *
 * The duplicate a double-tapped button produces is refused by
 * `reports_reporter_target_key` rather than by a `findOne` the second submission
 * would also pass. The caller decides what a `23505` means to its user; this
 * function does not translate it, because the intake path wants the raise and
 * an admin path might not.
 */
export async function insertReport(
  input: NewReport,
  db: DatabaseOrTransaction,
): Promise<ReportRecord> {
  const [row] = await db
    .insert(reports)
    .values({
      id: uuidv7(),
      reporter: input.reporter,
      reportedType: input.reportedType,
      reportedId: input.reportedId,
      contextJobId: input.contextJobId ?? null,
      categories: input.categories,
      details: input.details ?? null,
      status: input.status,
      localStatus: input.localStatus,
      localStatusReason: input.localStatusReason ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting a report returned no row');
  }
  return toRecord(row);
}

/** One report by id, or null. */
export async function findReportById(
  reportId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReportRecord | null> {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  return row ? toRecord(row) : null;
}

/** The report a CrowdSource case belongs to, or null. */
export async function findReportByCaseId(
  caseId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReportRecord | null> {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.crowdSourceCaseId, caseId))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** Record a successful hand-off to CrowdSource. */
export async function markReportSubmitted(
  reportId: string,
  receipt: {
    crowdSourceReportId: string;
    crowdSourceCaseId: string;
    crowdSourceMerged: boolean;
    contentSnapshotHash: string;
    submittedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({
      localStatus: 'submitted',
      crowdSourceReportId: receipt.crowdSourceReportId,
      crowdSourceCaseId: receipt.crowdSourceCaseId,
      crowdSourceMerged: receipt.crowdSourceMerged,
      contentSnapshotHash: receipt.contentSnapshotHash,
      submittedAt: receipt.submittedAt,
      // Cleared on success, so a stale error from an earlier attempt cannot sit
      // beside a delivered report and read as a live fault.
      lastDeliveryError: null,
      localStatusReason: null,
    })
    .where(eq(reports.id, reportId));
}

/** Record that a delivery attempt failed, for the operator trace. */
export async function markReportDeliveryFailed(
  reportId: string,
  error: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({ localStatus: 'delivery_failed', lastDeliveryError: error.slice(0, 2_000) })
    .where(eq(reports.id, reportId));
}

/** Close a report there is genuinely nothing left to do about. */
export async function closeReport(
  reportId: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({ localStatus: 'closed', localStatusReason: reason })
    .where(eq(reports.id, reportId));
}

/**
 * Apply a decision to a report, but only if it is NEWER than the last one.
 *
 * The predicate is the source's, and porting it is what turns it on: `null`
 * covers the source's `{$exists: false}` (no decision yet), and `< revision`
 * refuses a late delivery of an earlier one. Answers whether it applied, so the
 * caller can tell "superseded" from "written" rather than assuming.
 *
 * Deliveries are unordered, so the out-of-order case is ordinary rather than
 * exotic — the audit trail keeps every revision and only the CURRENT answer
 * reaches the report.
 */
export async function applyDecisionToReport(
  reportId: string,
  revision: number,
  state: { status: string; localStatus: string; localStatusReason?: string | undefined },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(reports)
    .set({
      status: state.status,
      localStatus: state.localStatus,
      decisionRevision: revision,
      ...(state.localStatusReason === undefined
        ? {}
        : { localStatusReason: state.localStatusReason }),
    })
    .where(
      and(
        eq(reports.id, reportId),
        or(isNull(reports.decisionRevision), lt(reports.decisionRevision, revision)),
      ),
    );
  return (result.count ?? 0) === 1;
}

/** Whether this reporter already reported this object, for the operator trace. */
export async function reportExistsForTarget(
  reporter: string,
  reportedType: string,
  reportedId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(reports)
    .where(
      and(
        eq(reports.reporter, reporter),
        eq(reports.reportedType, reportedType),
        eq(reports.reportedId, reportedId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Intake: what commits, and what is refused.
 *
 * Three claims, in order of how expensive they are to get wrong:
 *
 * 1. **A deliverable report and its outbox event commit in ONE transaction.**
 *    Two writes outside one give two silent failure modes — a report nothing will
 *    ever send, and a delivery event whose report was rolled back — and neither
 *    surfaces as an error when it happens.
 * 2. **A local-only type gets NO outbox row**, not one a worker skips later. A
 *    skipped row would dead-letter a report that is not defective.
 * 3. **A delivery only travels as context if the reporter was a party to it.**
 *    Without that check, anyone could report any account, attach any job id, and
 *    have Moovo package a stranger's delivery into a case for a jury to read.
 */

import { uuidv7 } from '@oxyhq/db';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertReport = vi.fn();
const isJobParty = vi.fn();
const enqueue = vi.fn();
const transaction = vi.fn();

/**
 * A transaction handle that is only ever compared by IDENTITY.
 *
 * The coupling this file guards is that the enqueue receives the handle the
 * transaction opened, rather than the root connection. Against a mock that is
 * an identity check and nothing more — whether the REAL root handle is
 * distinguishable from a real transaction handle is a question only a server can
 * answer, and `moderation.realdb.test.ts` asks it there.
 */
const TX = { rollback: () => undefined, marker: 'the-transaction-handle' };

vi.mock('../../../db/postgres.js', () => ({
  getDb: () => ({ transaction: (...args: unknown[]) => transaction(...args) }),
}));

vi.mock('../../../db/moderation/reportRepository.js', () => ({
  insertReport: (...args: unknown[]) => insertReport(...args),
}));

vi.mock('../../../db/moderation/moderationOutboxRepository.js', () => ({
  enqueueModerationOutboxRow: (...args: unknown[]) => enqueue(...args),
}));

// `jobs` is Postgres, and the seam is a repository function that answers a
// BOOLEAN. The ownership predicate is no longer a filter object a test can
// inspect field by field — it is a WHERE clause inside `isJobParty`, and
// `job-dispatch.realdb.test.ts` pins it against a real server, which is the only
// place a predicate can be pinned at all. What stays assertable here is the pair
// of ARGUMENTS: the job asked about, and the reporter asked about on it.
vi.mock('../../../db/transport/jobRepository.js', () => ({
  isJobParty: (...args: unknown[]) => isJobParty(...args),
}));

vi.mock('../moderation-outbox.service.js', () => ({
  reportSubmitEventId: (id: string) => `moderation:report.submit:${id}`,
}));

import { createReport } from '../report-intake.service.js';

const VALID_JOB_ID = uuidv7();

function storedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    reporter: 'reporter-1',
    reportedType: 'courier',
    reportedId: 'courier-1',
    status: 'pending',
    localStatus: 'queued',
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Run the transaction body inline, with the handle the real code would get.
  transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) =>
    await operation(TX),
  );
  insertReport.mockImplementation(async (doc: Record<string, unknown>) => storedReport(doc));
  enqueue.mockResolvedValue('moderation:report.submit:report-1');
  isJobParty.mockResolvedValue(false);
});

describe('a deliverable type', () => {
  it('stores the report queued and enqueues its delivery', async () => {
    const result = await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });

    expect(result.outboxEventId).toBe('moderation:report.submit:report-1');
    const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
    expect(doc?.localStatus).toBe('queued');
    expect(doc?.localStatusReason).toBeUndefined();
  });

  it('enqueues INSIDE the transaction, with the transaction handle itself', async () => {
    // The coupling this file exists for. Both writes must receive the handle the
    // transaction opened — a caller that reached for `getDb()` instead would
    // commit the outbox row on its own connection, leaving a report answered 201
    // with nothing owed to deliver it.
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    const [, reportHandle] = insertReport.mock.calls[0] as [unknown, unknown];
    const [, outboxHandle] = enqueue.mock.calls[0] as [unknown, unknown];
    expect(reportHandle).toBe(TX);
    expect(outboxHandle).toBe(TX);
  });

  /**
   * There is no session to end any more — drizzle's `transaction` owns the
   * connection and returns it whether the body resolves or throws. What still
   * has to hold is that a failed transaction fails the CALL rather than being
   * swallowed into a 201 for a report that was rolled back.
   */
  it('propagates a failed transaction instead of answering success', async () => {
    transaction.mockRejectedValue(new Error('write conflict'));
    await expect(
      createReport({
        reporter: 'reporter-1',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
      }),
    ).rejects.toThrow('write conflict');
  });
});

describe('a type with no subject provider', () => {
  it.each(['listing', 'store', 'review'] as const)(
    'stores a %s report locally and enqueues NOTHING',
    async (reportedType) => {
      const result = await createReport({
        reporter: 'reporter-1',
        reportedType,
        reportedId: 'thing-1',
        categories: ['other'],
      });

      // Not an outbox row a worker skips later — that would dead-letter a report
      // which is not defective.
      expect(enqueue).not.toHaveBeenCalled();
      expect(result.outboxEventId).toBeUndefined();
      const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
      expect(doc?.localStatus).toBe('received');
    },
  );

  it('records WHY in words an operator can read', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'listing',
      reportedId: 'listing-1',
      categories: ['other'],
    });
    const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
    // A missing outbox row is also what a lost write looks like; the reason is
    // what keeps the two distinguishable months later.
    expect(String(doc?.localStatusReason)).toContain('no moderation subject provider');
    expect(String(doc?.localStatusReason).length).toBeLessThanOrEqual(300);
  });
});

describe('the delivery-context ownership check', () => {
  it('attaches the delivery when the reporter was a party to it', async () => {
    isJobParty.mockResolvedValue(true);

    await createReport({
      reporter: 'sender-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
    expect(doc?.contextJobId).toBe(VALID_JOB_ID);
  });

  it('scopes the lookup to jobs the reporter was sender or courier on', async () => {
    isJobParty.mockResolvedValue(true);
    await createReport({
      reporter: 'sender-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    expect(isJobParty).toHaveBeenCalledWith(VALID_JOB_ID, 'sender-1');
  });

  /**
   * The IDOR this guard exists for.
   *
   * A delivery description — however redacted — is another customer's business:
   * item description, delivery instructions, coarse areas, timings. Without the
   * ownership check, anyone could report any account, attach any job id, and have
   * Moovo package a stranger's delivery into a case for a jury to read. The
   * leaked data is pushed to third parties rather than returned in the response,
   * so it would never appear in the attacker's own traffic.
   */
  it('DROPS a delivery the reporter had nothing to do with', async () => {
    isJobParty.mockResolvedValue(false);

    await createReport({
      reporter: 'a-stranger',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
    expect(doc?.contextJobId).toBeUndefined();
  });

  it('still stores the report when the context is dropped', async () => {
    // Deliberately silent: the report is valid and still delivered, and a 403
    // here would tell a prober which job ids exist.
    isJobParty.mockResolvedValue(false);
    const result = await createReport({
      reporter: 'a-stranger',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });
    expect(result.report).toBeDefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('never queries the database for a malformed job id', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: 'not-an-object-id',
    });
    expect(isJobParty).not.toHaveBeenCalled();
  });

  it('looks up a uuid v7 job id — the shape every job created after the cutover has', async () => {
    // The case every OTHER fixture in this file cannot express. `VALID_JOB_ID`
    // is an ObjectId hex, so the id guard being `isValidObjectId` or
    // `isLiveEntityId` makes no difference to any of them — they all sit on the
    // same side of the distinction the guard exists to make.
    //
    // It matters because this guard fails SILENTLY by design: an id it rejects
    // drops the delivery context and still stores the report, so a courier
    // reported for conduct on a post-cutover job would reach the jury with no
    // delivery attached and nothing logged to say why.
    const postCutoverJobId = uuidv7();
    isJobParty.mockResolvedValue(true);

    const result = await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: postCutoverJobId,
    });

    expect(isJobParty).toHaveBeenCalledTimes(1);
    expect(result.report).toBeDefined();
    const [doc] = insertReport.mock.calls[0] as [Record<string, unknown>];
    expect(doc?.contextJobId).toBe(postCutoverJobId);
  });
});

describe('identifier guards', () => {
  it.each([
    ['reporter', { reporter: '' }],
    ['reportedId', { reportedId: '  ' }],
  ])('refuses a blank %s before opening a transaction', async (_field, overrides) => {
    await expect(
      createReport({
        reporter: 'reporter-1',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
        ...overrides,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(transaction).not.toHaveBeenCalled();
  });

  /**
   * A query operator where an id belongs.
   *
   * The input type says `string`, but a type is erased at runtime and a
   * truthiness check passes `{ $ne: null }`. Handed that, a scoped `findOne`
   * matches an UNRELATED row — so the guard is a real defence, not a formality,
   * and it lives in the service because `createReport` is exported to callers
   * that never saw the route's validation.
   */
  it('refuses a Mongo operator smuggled in as an identifier', async () => {
    const operator = { $ne: null } as unknown as string;
    await expect(
      createReport({
        reporter: operator,
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a reported type the enum has never heard of', async () => {
    await expect(
      createReport({
        reporter: 'reporter-1',
        // A value only a non-route caller could produce.
        reportedType: 'spaceship' as never,
        reportedId: 'thing-1',
        categories: ['other'],
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

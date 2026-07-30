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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportCreate = vi.fn();
const jobFindOne = vi.fn();
const enqueue = vi.fn();
const withTransaction = vi.fn();
const endSession = vi.fn();
let sessionIsInTransaction = true;

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    default: {
      ...actual.default,
      isValidObjectId: actual.isValidObjectId,
      startSession: async () => ({
        withTransaction: (...args: unknown[]) => withTransaction(...args),
        endSession: (...args: unknown[]) => endSession(...args),
        inTransaction: () => sessionIsInTransaction,
      }),
    },
    isValidObjectId: actual.isValidObjectId,
  };
});

vi.mock('../../../models/report.js', () => ({
  Report: { create: (...args: unknown[]) => reportCreate(...args) },
}));

vi.mock('../../../models/job.js', () => ({
  Job: { findOne: (...args: unknown[]) => jobFindOne(...args) },
}));

vi.mock('../moderation-outbox.service.js', () => ({
  enqueueModerationOutboxEvent: (...args: unknown[]) => enqueue(...args),
  reportSubmitEventId: (id: string) => `moderation:report.submit:${id}`,
}));

import { createReport } from '../report-intake.service.js';

const VALID_JOB_ID = '507f1f77bcf86cd799439011';

/** A chainable `findOne().select().lean()`. */
function jobQuery(value: unknown) {
  return { select: () => ({ lean: async () => value }) };
}

function storedReport(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'report-1',
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
  sessionIsInTransaction = true;
  // Run the transaction body inline, with the session the real code would get.
  withTransaction.mockImplementation(async (operation: (s: unknown) => Promise<void>) => {
    await operation({ inTransaction: () => sessionIsInTransaction });
  });
  reportCreate.mockImplementation(async (docs: Record<string, unknown>[]) => [
    storedReport(docs[0]),
  ]);
  enqueue.mockResolvedValue('moderation:report.submit:report-1');
  jobFindOne.mockReturnValue(jobQuery(null));
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
    const [[docs]] = reportCreate.mock.calls as [[Record<string, unknown>[]]];
    expect(docs[0]?.localStatus).toBe('queued');
    expect(docs[0]?.localStatusReason).toBeUndefined();
  });

  it('enqueues INSIDE the transaction, with the same session', async () => {
    // The coupling this file exists for: the enqueue must receive a session that
    // is actually in a transaction, which is what `enqueueModerationOutboxEvent`
    // itself refuses to proceed without.
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const [, session] = enqueue.mock.calls[0] as [unknown, { inTransaction: () => boolean }];
    expect(session.inTransaction()).toBe(true);
  });

  it('always ends the session, even when the transaction throws', async () => {
    withTransaction.mockRejectedValue(new Error('write conflict'));
    await expect(
      createReport({
        reporter: 'reporter-1',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
      }),
    ).rejects.toThrow('write conflict');
    expect(endSession).toHaveBeenCalledTimes(1);
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
      const [[docs]] = reportCreate.mock.calls as [[Record<string, unknown>[]]];
      expect(docs[0]?.localStatus).toBe('received');
    },
  );

  it('records WHY in words an operator can read', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'listing',
      reportedId: 'listing-1',
      categories: ['other'],
    });
    const [[docs]] = reportCreate.mock.calls as [[Record<string, unknown>[]]];
    // A missing outbox row is also what a lost write looks like; the reason is
    // what keeps the two distinguishable months later.
    expect(String(docs[0]?.localStatusReason)).toContain('no moderation subject provider');
    expect(String(docs[0]?.localStatusReason).length).toBeLessThanOrEqual(300);
  });
});

describe('the delivery-context ownership check', () => {
  it('attaches the delivery when the reporter was a party to it', async () => {
    jobFindOne.mockReturnValue(jobQuery({ _id: VALID_JOB_ID }));

    await createReport({
      reporter: 'sender-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    const [[docs]] = reportCreate.mock.calls as [[Record<string, unknown>[]]];
    expect(docs[0]?.contextJobId).toBe(VALID_JOB_ID);
  });

  it('scopes the lookup to jobs the reporter was sender or courier on', async () => {
    jobFindOne.mockReturnValue(jobQuery({ _id: VALID_JOB_ID }));
    await createReport({
      reporter: 'sender-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    expect(jobFindOne).toHaveBeenCalledWith({
      _id: VALID_JOB_ID,
      $or: [{ senderOxyUserId: 'sender-1' }, { courierOxyUserId: 'sender-1' }],
    });
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
    jobFindOne.mockReturnValue(jobQuery(null));

    await createReport({
      reporter: 'a-stranger',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: VALID_JOB_ID,
    });

    const [[docs]] = reportCreate.mock.calls as [[Record<string, unknown>[]]];
    expect(docs[0]?.contextJobId).toBeUndefined();
  });

  it('still stores the report when the context is dropped', async () => {
    // Deliberately silent: the report is valid and still delivered, and a 403
    // here would tell a prober which job ids exist.
    jobFindOne.mockReturnValue(jobQuery(null));
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

  it('never queries Mongo for a malformed job id', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
      contextJobId: 'not-an-object-id',
    });
    expect(jobFindOne).not.toHaveBeenCalled();
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
    expect(withTransaction).not.toHaveBeenCalled();
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
    expect(withTransaction).not.toHaveBeenCalled();
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
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

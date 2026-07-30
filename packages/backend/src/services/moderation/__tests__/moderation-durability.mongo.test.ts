/**
 * The moderation writes, against a REAL MongoDB replica set.
 *
 * Every other moderation test in this repo mocks the model, and that is fine for
 * mapping tables and pure functions. It is worthless for the two invariants that
 * matter, because **a mocked `updateOne` accepts every update document —
 * including ones the server rejects.**
 *
 * The failure that motivates this file is not hypothetical. An update naming a
 * path in two operators at once — `updatedAt` in both `$set` and `$setOnInsert`,
 * which `{ timestamps: true }` produces on an upsert — is refused outright:
 *
 *     MongoServerError: Updating the path 'updatedAt' would create a conflict at 'updatedAt'
 *
 * Zero rows are written, and because the enqueue happens inside `createReport`'s
 * transaction the abort takes the `Report` with it, so `POST /reports` 500s for
 * every caller from the very first one. Against a mock the suite stays green,
 * and coverage stays green too: it measures which lines ran, not whether the
 * server would accept what they produced.
 *
 * So the tests below exercise the real driver, the real schemas (`timestamps`
 * options and all), the real unique indexes and real transactions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MOOVO_TEST_MONGODB_URI;

beforeAll(async () => {
  if (!MONGODB_URI) {
    throw new Error(
      'MOOVO_TEST_MONGODB_URI is unset — vitest.globalSetup.ts did not start the replica set.',
    );
  }
  await mongoose.connect(MONGODB_URI, { dbName: 'moovo-moderation-test' });
  // Unique indexes are the idempotency mechanism; without building them the
  // "a duplicate is refused" assertions below would pass vacuously.
  await Promise.all([
    Report.syncIndexes(),
    ModerationOutbox.syncIndexes(),
    ModerationEvent.syncIndexes(),
    ModerationEnforcement.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

import { Report } from '../../../models/report.js';
import { ModerationOutbox } from '../../../models/moderation-outbox.js';
import { ModerationEvent } from '../../../models/moderation-event.js';
import { ModerationEnforcement } from '../../../models/moderation-enforcement.js';
import {
  enqueueModerationOutboxEvent,
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  ModerationOutboxTransactionError,
  reportSubmitEventId,
} from '../moderation-outbox.service.js';
import { createReport } from '../report-intake.service.js';
import { mongoProcessedEventStore } from '../moderation-event-store.js';

beforeEach(async () => {
  await Promise.all([
    Report.deleteMany({}),
    ModerationOutbox.deleteMany({}),
    ModerationEvent.deleteMany({}),
    ModerationEnforcement.deleteMany({}),
  ]);
});

/** Run `operation` inside a real transaction, like the intake service does. */
async function inTransaction<T>(
  operation: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    if (result === undefined) throw new Error('transaction produced no result');
    return result;
  } finally {
    await session.endSession();
  }
}

describe('enqueueModerationOutboxEvent against a real server', () => {
  /**
   * The regression test for the `$setOnInsert` timestamps conflict.
   *
   * The assertion is simply that the write SUCCEEDS and the row exists. That is
   * the whole point: the broken shape does not produce a wrong row, it produces
   * a `MongoServerError` and no row at all, so "it wrote something" is exactly
   * the claim a mock cannot make.
   */
  it('actually writes a row — no path conflict between $setOnInsert and timestamps', async () => {
    const eventId = reportSubmitEventId('report-real-1');

    await inTransaction((session) =>
      enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'report-real-1' } },
        session,
      ),
    );

    const row = await ModerationOutbox.findById(eventId).lean();
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('lets `timestamps: true` populate createdAt and updatedAt itself', async () => {
    // The fix is to name NEITHER in `$setOnInsert`. Mongoose then supplies both,
    // and `claim`'s `sort: { createdAt: 1 }` still has a field to sort on — which
    // is the thing someone "fixing" this by deleting the wrong one would break.
    const eventId = reportSubmitEventId('report-real-2');
    await inTransaction((session) =>
      enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'report-real-2' } },
        session,
      ),
    );

    const row = await ModerationOutbox.findById(eventId).lean();
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('upserts idempotently: a second enqueue neither duplicates nor resets', async () => {
    const eventId = reportSubmitEventId('report-real-3');
    const enqueue = () =>
      inTransaction((session) =>
        enqueueModerationOutboxEvent(
          { eventId, kind: 'report.submit', payload: { reportId: 'report-real-3' } },
          session,
        ),
      );

    await enqueue();
    // Simulate a worker having already picked it up, then a retry re-enqueueing.
    await claimModerationOutboxEvent({ leaseOwner: 'owner-a' });
    await enqueue();

    expect(await ModerationOutbox.countDocuments({})).toBe(1);
    const row = await ModerationOutbox.findById(eventId).lean();
    // `$setOnInsert` only — a retry must not rewind `attempts` or the status.
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('processing');
  });

  it('REFUSES to write outside a transaction, and writes nothing', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:never', kind: 'report.submit', payload: {} },
          session,
        ),
      ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
    } finally {
      await session.endSession();
    }
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });
});

describe('the intake transaction against a real server', () => {
  it('commits the report and its outbox row together', async () => {
    const { report, outboxEventId } = await createReport({
      reporter: 'reporter-real-1',
      reportedType: 'courier',
      reportedId: 'courier-real-1',
      categories: ['harassment'],
    });

    const stored = await Report.findById(report._id).lean();
    expect(stored?.localStatus).toBe('queued');
    expect(await ModerationOutbox.findById(outboxEventId).lean()).not.toBeNull();
  });

  /**
   * The other half of the coupling, and the one only a real server can show.
   *
   * If the outbox write fails, the transaction aborts and the REPORT must be
   * gone too — not left behind as a row nothing will ever deliver. Forced here
   * by pre-inserting a row whose `_id` collides under a filter the upsert cannot
   * satisfy... which `$setOnInsert` tolerates, so instead the failure is induced
   * by aborting the transaction directly, which is what any driver error does.
   */
  it('leaves NO report behind when the transaction aborts', async () => {
    const session = await mongoose.startSession();
    const reporter = 'reporter-real-abort';
    try {
      await expect(
        session.withTransaction(async () => {
          await Report.create(
            [
              {
                reporter,
                reportedType: 'courier',
                reportedId: 'courier-real-abort',
                categories: ['harassment'],
                status: 'pending',
                localStatus: 'queued',
              },
            ],
            { session },
          );
          await enqueueModerationOutboxEvent(
            {
              eventId: 'moderation:report.submit:abort',
              kind: 'report.submit',
              payload: { reportId: 'abort' },
            },
            session,
          );
          throw new Error('induced failure after both writes');
        }),
      ).rejects.toThrow('induced failure');
    } finally {
      await session.endSession();
    }

    // Both writes rolled back together — the property the transaction exists for.
    expect(await Report.countDocuments({ reporter })).toBe(0);
    expect(await ModerationOutbox.countDocuments({ _id: 'moderation:report.submit:abort' })).toBe(0);
  });

  it('stores a local-only type with NO outbox row at all', async () => {
    const { report, outboxEventId } = await createReport({
      reporter: 'reporter-real-2',
      reportedType: 'listing',
      reportedId: 'listing-real-1',
      categories: ['other'],
    });

    expect(outboxEventId).toBeUndefined();
    const stored = await Report.findById(report._id).lean();
    expect(stored?.localStatus).toBe('received');
    expect(stored?.localStatusReason).toBeTruthy();
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });

  it('refuses a second report of the same thing by the same reporter', async () => {
    const input = {
      reporter: 'reporter-real-3',
      reportedType: 'courier' as const,
      reportedId: 'courier-real-3',
      categories: ['harassment' as const],
    };
    await createReport(input);

    // The unique index answers, not a pre-read — two taps of a button race a
    // `findOne` and both pass it.
    await expect(createReport(input)).rejects.toMatchObject({ code: 11000 });
    expect(await Report.countDocuments({ reporter: input.reporter })).toBe(1);
  });

  it('allows two DIFFERENT reporters to report the same courier', async () => {
    const base = {
      reportedType: 'courier' as const,
      reportedId: 'courier-real-4',
      categories: ['harassment' as const],
    };
    await createReport({ ...base, reporter: 'reporter-a' });
    await createReport({ ...base, reporter: 'reporter-b' });
    // Two reports, and CrowdSource's own dedup key is what merges them into one
    // case — that must not be pre-empted here.
    expect(await Report.countDocuments({ reportedId: 'courier-real-4' })).toBe(2);
  });
});

describe('outbox leases against a real server', () => {
  async function seed(eventId: string): Promise<void> {
    await inTransaction((session) =>
      enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: eventId } },
        session,
      ),
    );
  }

  it('lets only one owner claim a due event', async () => {
    await seed('moderation:report.submit:lease-1');
    const first = await claimModerationOutboxEvent({ leaseOwner: 'owner-a' });
    const second = await claimModerationOutboxEvent({ leaseOwner: 'owner-b' });
    expect(first?._id).toBe('moderation:report.submit:lease-1');
    // A live lease is not reclaimable, so the second worker finds nothing.
    expect(second).toBeNull();
  });

  it('refuses to complete a lease another owner holds', async () => {
    await seed('moderation:report.submit:lease-2');
    await claimModerationOutboxEvent({ leaseOwner: 'owner-a' });
    expect(
      await completeModerationOutboxEvent('moderation:report.submit:lease-2', 'owner-b'),
    ).toBe(false);
    const row = await ModerationOutbox.findById('moderation:report.submit:lease-2').lean();
    expect(row?.status).toBe('processing');
  });

  it('reclaims an expired lease so a dead worker cannot strand the work', async () => {
    await seed('moderation:report.submit:lease-3');
    await claimModerationOutboxEvent({ leaseOwner: 'owner-a', leaseMs: 1_000 });
    // Move the clock forward rather than sleeping.
    const later = new Date(Date.now() + 5_000);
    const reclaimed = await claimModerationOutboxEvent({ leaseOwner: 'owner-b', now: later });
    expect(reclaimed?._id).toBe('moderation:report.submit:lease-3');
    expect(reclaimed?.attempts).toBe(2);
  });
});

describe('the webhook dedupe store against a real server', () => {
  it('claims once and refuses the redelivery', async () => {
    const store = mongoProcessedEventStore();
    expect(await store.claim('evt_real_1')).toBe(true);
    // The duplicate-key error IS the answer "somebody else has this event",
    // which only a real unique index can produce.
    expect(await store.claim('evt_real_1')).toBe(false);
  });

  it('releases the claim so a retry can be processed', async () => {
    const store = mongoProcessedEventStore();
    await store.claim('evt_real_2');
    await store.release('evt_real_2');
    expect(await store.claim('evt_real_2')).toBe(true);
  });
});

describe('enforcement idempotency against a real server', () => {
  const base = {
    decisionId: 'dec_real_1',
    action: 'suspend_courier' as const,
    targetType: 'courier' as const,
    targetId: 'courier-real-9',
    applied: false,
    reason: 'CrowdSource recommended remove',
  };

  it('refuses a second row for the same decision + revision + action', async () => {
    await ModerationEnforcement.create({ ...base, revision: 1 });
    await expect(ModerationEnforcement.create({ ...base, revision: 1 })).rejects.toMatchObject({
      code: 11000,
    });
  });

  /**
   * The reason `revision` is in the key.
   *
   * A correction's reinstatement must be a DIFFERENT action from the suspension
   * it supersedes. Drop `revision` and it collides with the earlier row, is
   * treated as already applied, and an accepted appeal can never put anything
   * back — with no error anywhere.
   */
  it('admits the same action at a later revision', async () => {
    await ModerationEnforcement.create({ ...base, revision: 1 });
    await expect(
      ModerationEnforcement.create({ ...base, revision: 2 }),
    ).resolves.toBeDefined();
    expect(await ModerationEnforcement.countDocuments({ decisionId: 'dec_real_1' })).toBe(2);
  });

  it('admits a different action at the same revision', async () => {
    await ModerationEnforcement.create({ ...base, revision: 1 });
    await expect(
      ModerationEnforcement.create({ ...base, revision: 1, action: 'manual_review' }),
    ).resolves.toBeDefined();
  });
});

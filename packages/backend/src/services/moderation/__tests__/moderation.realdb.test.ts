/**
 * The moderation domain against a real PostgreSQL server.
 *
 * This file replaces `moderation-durability.mongo.test.ts` and exists for the
 * same reason that one did: **a mocked repository accepts every statement,
 * including ones the server rejects.** The Mongo version was written after an
 * update naming `updatedAt` under two operators passed a whole mocked suite and
 * failed every real write; the engine changed, the blind spot did not.
 *
 * Every property below is one a mock cannot hold, and most fail in the direction
 * that LOOKS like working software:
 *
 *  - **The enqueue is a genuine no-op on a repeat.** `ON CONFLICT (id) DO
 *    NOTHING` writes no tuple version, no timestamp and takes no lock. Asserted
 *    on `xmin` as well as `updated_at`, because a careful `DO UPDATE` setting
 *    every column to its current value would leave `updated_at` alone and still
 *    bump the tuple — so `updated_at` alone cannot tell the two apart.
 *  - **The transaction guard, against REAL handles.** `requireTransaction`
 *    discriminates on whether the handle carries `.rollback`. Whether `getDb()`
 *    genuinely lacks it and a real transaction handle genuinely has it is not a
 *    question a hand-made session object can answer — the old mocked test
 *    proved only that the guard consulted its argument.
 *  - **Neither claim-by-unique may RAISE.** A `23505` aborts the whole
 *    surrounding transaction, and both claims run inside one. Asserted by
 *    issuing a further statement AFTER the duplicate and requiring it to work —
 *    which is the only thing that distinguishes "returned false" from "poisoned
 *    the transaction".
 *  - **The three lease transitions do not share count semantics.** Each is
 *    called TWICE, and the second call is asserted on the ROW rather than on the
 *    number: under Mongoose `timestamps: true` made `modifiedCount` agree with
 *    `matchedCount` for a reason that had nothing to do with `status`, so a test
 *    comparing two numbers passes on that coincidence. Which column carries the
 *    evidence differs by case, and getting it wrong looks like flakiness — a
 *    transition whose predicate MATCHES always bumps `updated_at` (drizzle's
 *    `$onUpdate` is in every SET clause), so only `lease_until` can show that a
 *    renewal had nothing new to write; a transition whose predicate matches
 *    NOTHING issues no UPDATE at all, so there `updated_at` and `xmin` are the
 *    right evidence. Both are measured below rather than assumed.
 *  - **`decisionRevision`, in BOTH directions.** The guard has never held in
 *    production — `ReportSchema` declared no such path, so Mongoose stripped it
 *    from every `$set` and the `{$lt}` arm could never match. Storing the column
 *    turns it on, which is a behaviour CHANGE, so the refusal and the admission
 *    are pinned separately.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { getDb } from '../../../db/postgres';
import { reports } from '../../../db/schema/moderation';
import {
  applyDecisionToReport,
  findReportByCaseId,
  findReportById,
  insertReport,
  markReportSubmitted,
} from '../../../db/moderation/reportRepository';
import {
  claimModerationOutboxRow,
  completeModerationOutboxRow,
  enqueueModerationOutboxRow,
  releaseModerationOutboxRow,
  renewModerationOutboxRow,
} from '../../../db/moderation/moderationOutboxRepository';
import {
  claimModerationEvent,
  releaseModerationEvent,
} from '../../../db/moderation/moderationEventRepository';
import { claimModerationEnforcement } from '../../../db/moderation/moderationEnforcementRepository';
import { createReport, isDuplicateReportError } from '../report-intake.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, 120_000);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

afterEach(async () => {
  // Order matters: `moderation_enforcements.report_id` references `reports`.
  await getDb().execute(sql`truncate table moderation_enforcements, moderation_outboxes,
    moderation_events, reports restart identity cascade`);
});

/** The row's storage-level state, which is what a "no-op" claim is about. */
async function outboxRowState(
  eventId: string,
): Promise<{ xmin: string; updatedAt: string; attempts: number; status: string }> {
  const rows = await getDb().execute<{
    xmin: string;
    updated_at: string;
    attempts: number;
    status: string;
  }>(sql`select xmin::text as xmin, updated_at::text as updated_at, attempts, status
         from moderation_outboxes where id = ${eventId}`);
  const row = rows[0];
  if (!row) throw new Error(`No outbox row for '${eventId}'`);
  return {
    xmin: row.xmin,
    updatedAt: row.updated_at,
    attempts: Number(row.attempts),
    status: row.status,
  };
}

async function outboxLeaseUntil(eventId: string): Promise<string> {
  const rows = await getDb().execute<{ lease_until: string }>(
    sql`select lease_until::text as lease_until from moderation_outboxes where id = ${eventId}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`No outbox row for '${eventId}'`);
  return row.lease_until;
}

async function reportUpdatedAt(reportId: string): Promise<string> {
  const rows = await getDb().execute<{ updated_at: string }>(
    sql`select updated_at::text as updated_at from reports where id = ${reportId}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`No report row for '${reportId}'`);
  return row.updated_at;
}

const ENQUEUE = {
  eventId: 'moderation:report.submit:report-1',
  kind: 'report.submit' as const,
  payload: { reportId: 'report-1' },
};

describeIfPostgres('the outbox enqueue against a real server', () => {
  it('actually writes a row', async () => {
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(ENQUEUE, tx);
    });

    const state = await outboxRowState(ENQUEUE.eventId);
    expect(state.status).toBe('pending');
    expect(state.attempts).toBe(0);
  });

  /**
   * The property the deterministic id exists to provide.
   *
   * `xmin` is the discriminating observable. A `DO UPDATE` careful enough to
   * write every column back at its current value would leave `updated_at`
   * untouched — `$onUpdate` only fires on a real change — and still create a new
   * tuple version. Only `xmin` separates "wrote nothing" from "wrote the same
   * thing", and the difference matters because a write takes a row lock the
   * dispatcher may be concurrently holding.
   */
  it('is a GENUINE no-op on a repeat: neither updated_at nor xmin moves', async () => {
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(ENQUEUE, tx);
    });
    const before = await outboxRowState(ENQUEUE.eventId);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(ENQUEUE, tx);
    });
    const after = await outboxRowState(ENQUEUE.eventId);

    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.xmin).toBe(before.xmin);
  });

  it('a repeat neither duplicates the row nor resets its attempts', async () => {
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(ENQUEUE, tx);
    });
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(ENQUEUE, tx);
    });

    const rows = await getDb().execute<{ count: string }>(
      sql`select count(*)::text as count from moderation_outboxes`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
    // The claim incremented attempts; a repeat enqueue that reset them would
    // hand a failing event an unlimited retry budget.
    expect((await outboxRowState(ENQUEUE.eventId)).attempts).toBe(1);
  });

  /**
   * The invariant the whole table exists for, and the ONLY place it can be
   * established.
   *
   * `DatabaseOrTransaction` is a union the root handle satisfies, so a caller
   * that forgets to pass `tx` type-checks perfectly. The guard discriminates at
   * runtime on `.rollback`, and only real handles can show that the
   * discriminator is true of one and false of the other.
   */
  it('REFUSES the root connection, and writes nothing', async () => {
    await expect(enqueueModerationOutboxRow(ENQUEUE, getDb())).rejects.toThrow(
      /must run inside a transaction/,
    );

    const rows = await getDb().execute<{ count: string }>(
      sql`select count(*)::text as count from moderation_outboxes`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('accepts a real transaction handle', async () => {
    // The other half of the discriminator: if `.rollback` were absent from a
    // real transaction handle too, the guard would refuse everything and the
    // refusal test above would still pass.
    await expect(
      getDb().transaction(async (tx) => await enqueueModerationOutboxRow(ENQUEUE, tx)),
    ).resolves.toBe(ENQUEUE.eventId);
  });
});

describeIfPostgres('the intake transaction against a real server', () => {
  it('commits the report and its outbox row together', async () => {
    const result = await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });

    expect(result.outboxEventId).toBe(`moderation:report.submit:${result.report.id}`);
    expect(await findReportById(result.report.id)).not.toBeNull();
    expect(await outboxRowState(`moderation:report.submit:${result.report.id}`)).toMatchObject({
      status: 'pending',
    });
  });

  it('stores a local-only type with NO outbox row at all', async () => {
    const result = await createReport({
      reporter: 'reporter-1',
      reportedType: 'listing',
      reportedId: 'listing-1',
      categories: ['other'],
    });

    expect(result.outboxEventId).toBeUndefined();
    const rows = await getDb().execute<{ count: string }>(
      sql`select count(*)::text as count from moderation_outboxes`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
    expect(result.report.localStatus).toBe('received');
    expect(result.report.localStatusReason).toContain('no moderation subject provider');
  });

  it('refuses a second report of the same thing by the same reporter', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });

    // `reports_reporter_target_key`, not a pre-read: two concurrent submissions
    // from a double-tapped button both pass a `findOne` and the second opens a
    // second case for one incident.
    await expect(
      createReport({
        reporter: 'reporter-1',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'reports_reporter_target_key'),
    );
  });

  /**
   * `isDuplicateReportError` must recognise the error the server ACTUALLY
   * throws, and only a real one can establish that.
   *
   * **Drizzle wraps the driver failure in its own error, so the SQLSTATE is on
   * `cause` and not on the error you catch.** A predicate reading `error.code`
   * directly matches nothing, and because `routes/reports.ts` uses this to
   * choose between "you already reported this" and an unhandled 500, the whole
   * symptom is a 500 on every duplicate — with nothing pointing here.
   *
   * A SYNTHETIC `{ code: '23505' }` fixture cannot tell the two readings apart:
   * it satisfies both. The fixture has to be the error a real duplicate insert
   * produces, which is why this assertion lives here and not in a mocked suite.
   * Measured: the predicate WAS written the direct-`code` way, this test is what
   * caught it, and mutating it back turns exactly this case red.
   */
  it('isDuplicateReportError recognises the REAL error a duplicate produces', async () => {
    const input = {
      reporter: 'reporter-1',
      reportedType: 'courier' as const,
      reportedId: 'courier-1',
      categories: ['harassment' as const],
    };
    await createReport(input);

    const error = await createReport(input).then(
      () => {
        throw new Error('The duplicate was accepted, so there is no error to classify.');
      },
      (caught: unknown) => caught,
    );

    expect(isDuplicateReportError(error)).toBe(true);
    // The negative side, so the predicate is not simply "an error happened":
    // a CHECK violation from the same table must NOT read as a duplicate.
    const checkError = await getDb()
      .insert(reports)
      .values({
        id: uuidv7(),
        reporter: 'reporter-9',
        reportedType: 'spaceship',
        reportedId: 'thing-1',
        categories: ['other'],
        status: 'pending',
        localStatus: 'received',
      })
      .then(
        () => {
          throw new Error('The CHECK did not fire.');
        },
        (caught: unknown) => caught,
      );
    expect(isDuplicateReportError(checkError)).toBe(false);
  });

  it('allows two DIFFERENT reporters to report the same courier', async () => {
    await createReport({
      reporter: 'reporter-1',
      reportedType: 'courier',
      reportedId: 'courier-1',
      categories: ['harassment'],
    });
    await expect(
      createReport({
        reporter: 'reporter-2',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment'],
      }),
    ).resolves.toBeDefined();
  });
});

describeIfPostgres('outbox leases against a real server', () => {
  async function enqueue(eventId: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxRow(
        { eventId, kind: 'report.submit', payload: { reportId: 'report-1' } },
        tx,
      );
    });
  }

  it('lets only one owner claim a due event', async () => {
    await enqueue('lease-1');
    const first = await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });
    const second = await claimModerationOutboxRow({ leaseOwner: 'owner-b', leaseMs: 60_000 });

    expect(first?.id).toBe('lease-1');
    expect(second).toBeNull();
  });

  it('reclaims an expired lease so a dead worker cannot strand the work', async () => {
    await enqueue('lease-2');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 1_000 });

    const later = new Date(Date.now() + 5_000);
    const reclaimed = await claimModerationOutboxRow({
      leaseOwner: 'owner-b',
      now: later,
      leaseMs: 60_000,
    });
    expect(reclaimed?.id).toBe('lease-2');
  });

  it('refuses to complete a lease another owner holds', async () => {
    await enqueue('lease-3');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });
    expect(await completeModerationOutboxRow('lease-3', 'owner-b')).toBe(false);
  });

  /**
   * The count-semantics decision, and the reason each transition is called
   * TWICE.
   *
   * `renew` reads a MATCH count deliberately: two renewals inside one
   * millisecond compute an identical `leaseUntil`, so a renewal that held its
   * lease perfectly modifies nothing. Re-spelling it as "did something change"
   * reports a LOST lease that was never lost, and the dispatcher answers a lost
   * lease by abandoning delivery mid-flight.
   *
   * A test comparing only the returned number cannot check that. The second
   * renewal must be asserted on `updated_at`: it stays put, proving the row was
   * matched without being modified, while the call still answers `true`.
   */
  it('renew answers true on a second renewal that computes the SAME lease', async () => {
    await enqueue('lease-4');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });

    const at = new Date();
    expect(await renewModerationOutboxRow('lease-4', 'owner-a', 60_000, at)).toBe(true);
    const firstLease = await outboxLeaseUntil('lease-4');

    // Same `now` and same lease length, so `lease_until` cannot move. Under
    // Mongo this is precisely the case `modifiedCount` reported as FAILURE, and
    // the dispatcher answers a lost lease by abandoning delivery mid-flight.
    expect(await renewModerationOutboxRow('lease-4', 'owner-a', 60_000, at)).toBe(true);
    expect(await outboxLeaseUntil('lease-4')).toBe(firstLease);
  });

  /**
   * Why the Postgres count behaves like `matchedCount` here — measured, because
   * the mechanism is not the one it looks like.
   *
   * It is NOT that the row went untouched: `updated_at` carries drizzle's
   * `$onUpdate`, which is added to the SET clause of every `.set()` this
   * repository issues, so a matched row is always modified and the row count is
   * 1 whenever the predicate matched. The renewal above therefore answers `true`
   * because it MATCHED, not because anything about the lease changed — which is
   * exactly the semantic `renew` needs and the one `complete`/`fail` get for a
   * different reason (they always move `status`).
   *
   * Recorded here rather than in a comment on the repository because it is only
   * observable against a real server, and because a reader who assumed the
   * no-op reading would write the assertion above as `updated_at` staying put
   * and watch it fail for a reason that looks like flakiness.
   */
  it('a matched renewal still bumps updated_at, which is why the count is a MATCH count', async () => {
    await enqueue('lease-4b');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });

    const at = new Date();
    await renewModerationOutboxRow('lease-4b', 'owner-a', 60_000, at);
    const afterFirst = await outboxRowState('lease-4b');

    await new Promise((resolve) => setTimeout(resolve, 25));
    await renewModerationOutboxRow('lease-4b', 'owner-a', 60_000, at);
    const afterSecond = await outboxRowState('lease-4b');

    expect(afterSecond.updatedAt).not.toBe(afterFirst.updatedAt);
  });

  it('refuses to renew a lease another owner holds', async () => {
    await enqueue('lease-4c');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });
    expect(await renewModerationOutboxRow('lease-4c', 'owner-b', 60_000)).toBe(false);
  });

  it('complete and fail coincide with a match count only because they move status', async () => {
    await enqueue('lease-5');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });

    expect(await completeModerationOutboxRow('lease-5', 'owner-a')).toBe(true);
    const afterFirst = await outboxRowState('lease-5');
    expect(afterFirst.status).toBe('processed');

    // The second call finds no `processing` row to own, so it answers false AND
    // leaves the row alone. Both halves are asserted: a transition that answered
    // false while still writing would be the silent overwrite this guards.
    expect(await completeModerationOutboxRow('lease-5', 'owner-a')).toBe(false);
    const afterSecond = await outboxRowState('lease-5');
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecond.xmin).toBe(afterFirst.xmin);
  });

  it('release answers false and writes nothing once the lease is gone', async () => {
    await enqueue('lease-6');
    await claimModerationOutboxRow({ leaseOwner: 'owner-a', leaseMs: 60_000 });

    const release = {
      eventId: 'lease-6',
      status: 'pending' as const,
      availableAt: new Date(Date.now() + 60_000),
      lastError: 'first failure',
    };
    expect(await releaseModerationOutboxRow(release, 'owner-a')).toBe(true);
    const afterFirst = await outboxRowState('lease-6');

    expect(await releaseModerationOutboxRow(release, 'owner-a')).toBe(false);
    const afterSecond = await outboxRowState('lease-6');
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecond.xmin).toBe(afterFirst.xmin);
  });
});

describeIfPostgres('the webhook dedupe store against a real server', () => {
  it('claims once and refuses the redelivery', async () => {
    expect(await claimModerationEvent('evt_1')).toBe(true);
    expect(await claimModerationEvent('evt_1')).toBe(false);
  });

  it('releases the claim so a retry can be processed', async () => {
    await claimModerationEvent('evt_2');
    await releaseModerationEvent('evt_2');
    expect(await claimModerationEvent('evt_2')).toBe(true);
  });

  /**
   * The reason the claim must not raise, stated as the failure it prevents.
   *
   * The source inserted and caught a duplicate-key error. In Postgres a raised
   * `23505` aborts the surrounding transaction, so every later statement fails
   * with `25P02` — and the webhook path runs inside one. Answering `false` is
   * not enough on its own; what has to hold is that the transaction is still
   * USABLE afterwards, which only a further statement can show.
   */
  it('a refused claim leaves the surrounding transaction usable', async () => {
    await claimModerationEvent('evt_3');

    const stillWorks = await getDb().transaction(async (tx) => {
      const claimed = await claimModerationEvent('evt_3', new Date(), tx);
      expect(claimed).toBe(false);
      // If the duplicate had raised, this would fail with 25P02.
      const rows = await tx.execute<{ ok: number }>(sql`select 1 as ok`);
      return rows[0]?.ok;
    });
    expect(stillWorks).toBe(1);
  });
});

describeIfPostgres('enforcement idempotency against a real server', () => {
  const base = {
    decisionId: 'dec_1',
    revision: 1,
    action: 'suspend_courier',
    targetType: 'courier',
    targetId: 'courier-1',
    reason: 'A jury found the conduct in violation.',
  };

  it('refuses a second row for the same decision + revision + action', async () => {
    expect(await claimModerationEnforcement(base)).not.toBeNull();
    expect(await claimModerationEnforcement(base)).toBeNull();
  });

  /**
   * `revision` in the unique key is the part that is easy to drop and expensive
   * to lose: a successful appeal is a NEW revision, and its `restore` must be a
   * DIFFERENT action from the removal it supersedes. Without `revision` the
   * restore collides, reads as already applied, and an accepted appeal can never
   * put anything back — with no error anywhere.
   */
  it('admits the same action at a later revision', async () => {
    await claimModerationEnforcement(base);
    expect(await claimModerationEnforcement({ ...base, revision: 2 })).not.toBeNull();
  });

  it('admits a different action at the same revision', async () => {
    await claimModerationEnforcement(base);
    expect(
      await claimModerationEnforcement({ ...base, action: 'reinstate_courier' }),
    ).not.toBeNull();
  });

  it('a refused claim leaves the surrounding transaction usable', async () => {
    await claimModerationEnforcement(base);

    // A decision plans SEVERAL actions. One already-claimed action raising would
    // abandon every action after it in the same transaction.
    const secondActionId = await getDb().transaction(async (tx) => {
      expect(await claimModerationEnforcement(base, tx)).toBeNull();
      return await claimModerationEnforcement({ ...base, action: 'manual_review' }, tx);
    });
    expect(secondActionId).not.toBeNull();
  });
});

describeIfPostgres('the decisionRevision guard, which starts working here', () => {
  async function storedReport(): Promise<string> {
    const report = await getDb().transaction(
      async (tx) =>
        await insertReport(
          {
            reporter: 'reporter-1',
            reportedType: 'courier',
            reportedId: 'courier-1',
            categories: ['harassment'],
            status: 'pending',
            localStatus: 'queued',
          },
          tx,
        ),
    );
    await markReportSubmitted(report.id, {
      crowdSourceReportId: 'csr_1',
      crowdSourceCaseId: 'case_1',
      crowdSourceMerged: false,
      contentSnapshotHash: 'a'.repeat(64),
      submittedAt: new Date(),
    });
    return report.id;
  }

  it('admits the FIRST decision a report ever receives', async () => {
    const reportId = await storedReport();
    // The `IS NULL` arm. Without it a report with no recorded revision would
    // never be updated at all, and every decision would be silently dropped.
    expect(
      await applyDecisionToReport(reportId, 1, { status: 'resolved', localStatus: 'closed' }),
    ).toBe(true);
    expect((await findReportById(reportId))?.decisionRevision).toBe(1);
  });

  it('admits a NEWER revision', async () => {
    const reportId = await storedReport();
    await applyDecisionToReport(reportId, 1, { status: 'resolved', localStatus: 'closed' });
    expect(
      await applyDecisionToReport(reportId, 2, { status: 'dismissed', localStatus: 'closed' }),
    ).toBe(true);
    expect((await findReportById(reportId))?.status).toBe('dismissed');
  });

  /**
   * The direction that has never held in production.
   *
   * A correction and the decision it supersedes are separate webhook events with
   * separate retry schedules, so revision 1 can be retried after revision 2 has
   * been applied. Under Mongoose the column was never stored, so this refusal
   * never happened: the retry overwrote an accepted appeal's `dismissed` with
   * `resolved`, and the report said the courier was found in violation of
   * something they had been cleared of.
   */
  it('REFUSES a late delivery of an earlier revision, and writes nothing', async () => {
    const reportId = await storedReport();
    await applyDecisionToReport(reportId, 2, { status: 'dismissed', localStatus: 'closed' });
    const before = await reportUpdatedAt(reportId);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      await applyDecisionToReport(reportId, 1, { status: 'resolved', localStatus: 'closed' }),
    ).toBe(false);

    const after = await findReportById(reportId);
    expect(after?.status).toBe('dismissed');
    expect(after?.decisionRevision).toBe(2);
    // The refusal must be a non-write, not a write that happens to restore the
    // same values — `updated_at` is what separates them.
    expect(await reportUpdatedAt(reportId)).toBe(before);
  });

  it('REFUSES a redelivery of the revision already applied', async () => {
    const reportId = await storedReport();
    await applyDecisionToReport(reportId, 1, { status: 'resolved', localStatus: 'closed' });
    // `<` rather than `<=`: an at-least-once delivery makes an exact repeat the
    // common case, and re-applying it would move `updated_at` on every retry.
    expect(
      await applyDecisionToReport(reportId, 1, { status: 'resolved', localStatus: 'closed' }),
    ).toBe(false);
  });

  it('finds the report a case belongs to', async () => {
    const reportId = await storedReport();
    expect((await findReportByCaseId('case_1'))?.id).toBe(reportId);
    expect(await findReportByCaseId('case_absent')).toBeNull();
  });
});

describeIfPostgres('the reports table itself', () => {
  it('refuses a reported type outside the closed set', async () => {
    // The CHECK is the backstop behind `requireReportedType`. A service-layer
    // guard holds until the second caller arrives; this one holds against `psql`.
    await expect(
      getDb().insert(reports).values({
        id: uuidv7(),
        reporter: 'reporter-1',
        reportedType: 'spaceship',
        reportedId: 'thing-1',
        categories: ['other'],
        status: 'pending',
        localStatus: 'received',
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'reports_reported_type_check'),
    );
  });

  it('refuses a category outside the closed set', async () => {
    await expect(
      getDb().insert(reports).values({
        id: uuidv7(),
        reporter: 'reporter-1',
        reportedType: 'courier',
        reportedId: 'courier-1',
        categories: ['harassment', 'not-a-category'],
        status: 'pending',
        localStatus: 'received',
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'reports_categories_check'),
    );
  });
});

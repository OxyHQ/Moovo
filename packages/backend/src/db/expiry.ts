/**
 * The replacement for Moovo's five Mongo TTL indexes.
 *
 * Postgres has no TTL index. Mongo reaped these rows; nothing in Postgres
 * does, and the absence is INVISIBLE — there is no deleted call site, no
 * orphaned function, nothing a reviewer diffing the port would see go missing.
 * A table ported without an entry here simply grows forever, with no error and
 * no failing test, until somebody notices the disk or notices rows being
 * served that should have been gone.
 *
 * `@oxyhq/db` supplies the SWEEP. This file supplies the two halves that are
 * Moovo's: the REGISTRY of what to reap, and — below it — the CALLER that
 * actually runs it on a schedule. A registry with no caller is the failure
 * this file most needs to avoid, because it looks complete: every table is
 * listed, every retention is stated, and nothing ever deletes a row.
 *
 * ## Two of the five carry a PARTIAL filter, and neither can lose it
 *
 * ## ONE of the five carries a PARTIAL filter, and it cannot lose it
 *
 * `ExpirySweepTarget` is `{table, column, retentionSeconds}` — there is no
 * predicate field, so a partial filter has nowhere to live as a sweep
 * argument. `notifications` is folded into a GENERATED COLUMN on the table
 * itself (`dismissedSince`), which is NULL for any row that must not be
 * reaped. `NULL <= now() - interval` is never true, so the filter cannot be
 * omitted by a caller — there is no argument to omit.
 *
 * The other four are flat, and `jobOffers` is flat ON PURPOSE: its source
 * index carries no partial filter, and narrowing it would disable a backstop
 * in the only case a backstop matters. See its column comment.
 */

import { sweepAllExpiredRows, type ExpirySweepResult, type ExpirySweepTarget } from '@oxyhq/db/expiry';
import { getDb } from './postgres';
import { log } from '../lib/logger.js';
import { jobOffers, quotes } from './schema/transport';
import { moderationEvents, moderationOutboxes } from './schema/moderation';
import { notifications, NOTIFICATION_DISMISSED_RETENTION_SECONDS } from './schema/notifications';

/** `expireAfterSeconds: 0` — the column IS the deadline. */
const DEADLINE_IS_THE_COLUMN = 0;

/**
 * Every table that carried a TTL index, and what deleting a row costs.
 *
 * Each entry was checked for INTENT rather than replicated: a TTL index can be
 * written meaning "mark this expired" and quietly destroy history instead.
 */
export const EXPIRY_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: quotes,
    column: quotes.expiresAt,
    retentionSeconds: DEADLINE_IS_THE_COLUMN,
    reason:
      'A lapsed quote is not offerable and is never re-priced; the shipment it ' +
      'belongs to keeps its own record of which quote was selected.',
  },
  {
    table: jobOffers,
    column: jobOffers.expiresAt,
    retentionSeconds: DEADLINE_IS_THE_COLUMN,
    reason:
      'A lapsed offer is dispatch bookkeeping, not history — the job carries ' +
      'the outcome. Swept UNCONDITIONALLY, exactly as the source index does: ' +
      'this is the bounded-growth BACKSTOP behind the semantic ' +
      '`offered → expired` flip, so narrowing it to already-flipped rows would ' +
      'remove the protection in the one case it exists for — a wedged flip.',
  },
  {
    table: moderationEvents,
    column: moderationEvents.expiresAt,
    retentionSeconds: DEADLINE_IS_THE_COLUMN,
    reason:
      'The row is a dedupe claim plus an audit trail, kept comfortably longer ' +
      'than any sender-side retry schedule (30 days). Past that a redelivery is ' +
      'no longer expected, so the claim has nothing left to protect.',
  },
  {
    table: moderationOutboxes,
    column: moderationOutboxes.expiresAt,
    retentionSeconds: DEADLINE_IS_THE_COLUMN,
    reason:
      'A processed or dead-lettered row is an audit trail, not state (30 days). ' +
      'HAZARD, stated because this table holds UNPROCESSED WORK: `expiresAt` is ' +
      'set at enqueue, not at completion, so a dispatcher stalled for the whole ' +
      'retention window would have its backlog deleted by this sweep rather ' +
      'than delivered. The dispatcher stopping is the incident; this sweep is ' +
      'what makes it lossy. Alert on outbox age, not on this sweep.',
  },
  {
    table: notifications,
    column: notifications.dismissedSince,
    retentionSeconds: NOTIFICATION_DISMISSED_RETENTION_SECONDS,
    reason:
      'A DISMISSED notification is discarded 90 days after it was created. A ' +
      'notification in any other state is never reaped, however old — which is ' +
      'why the column is `dismissedSince` and not `createdAt`.',
  },
];

/**
 * Tables that GROW and are deliberately NOT swept, each with the reason and the
 * decision still owed.
 *
 * This list exists because absence from `EXPIRY_TARGETS` above is otherwise
 * indistinguishable between "nothing here needs reaping" and "nobody has
 * looked" — and the second is exactly the silent, symptomless growth this file
 * exists to prevent. A growing table must be in ONE of the two lists; being in
 * neither is the failure.
 *
 * Not a registry the sweep reads: it takes no column and schedules nothing, on
 * purpose. A target with a retention nobody agreed is worse than an honest gap,
 * because it deletes on a guess.
 */
export const UNSWEPT_GROWING_TABLES: readonly { table: string; why: string }[] = [
  {
    table: 'job_location_pings',
    why:
      "The source capped this trail with `$push … $slice: -N`, which was a " +
      'MONGO DOCUMENT-SIZE concern rather than a retention policy — a row has ' +
      'no such limit, so the port moved the cap to the READ ' +
      '(`listRecentLocationPings`) and keeps every ping. Registering it here ' +
      'needs a retention in seconds, and no defensible number is derivable ' +
      'from this repo: the figure that matters is how long a courier route ' +
      'must stay reconstructible for a DISPUTE, which is a product decision. ' +
      'Closing it is one entry above keyed on `at`, plus a leading btree on ' +
      'that column. See AGENTS.md §"Open decisions the Postgres port left".',
  },
];

/**
 * How often the sweep runs.
 *
 * Mongo's TTL monitor ran once a minute. This is deliberately much slower:
 * every read path filters on its own deadline independently of the sweep (a
 * lapsed quote is not selectable, an expired offer is not acceptable), so a
 * not-yet-swept row is stale but never unsafe. The sweep is disk hygiene, not
 * correctness, and running it hourly keeps it off the request path.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** Run every target once. Exported so a test can drive it without a timer. */
export async function sweepExpiredRowsOnce(): Promise<ExpirySweepResult[]> {
  return await sweepAllExpiredRows(getDb(), EXPIRY_TARGETS);
}

async function runOnce(): Promise<void> {
  try {
    const results = await sweepExpiredRowsOnce();
    const deleted = results.filter((result) => result.deleted > 0 || result.truncated);
    if (deleted.length > 0) {
      log.db.info({ results: deleted }, '[Expiry] swept expired rows');
    } else {
      // Unconditional, and the case that matters most. "Swept nothing" and
      // "never ran" are indistinguishable from outside the process, and the
      // moment anyone asks the difference it will be during an incident where
      // a table is growing and nobody can tell which is happening. One line
      // per run, naming the tables examined, makes it answerable.
      log.db.debug(
        { tables: results.map((result) => result.table) },
        '[Expiry] sweep ran; nothing was due',
      );
    }
  } catch (error: unknown) {
    // The loop must survive anything one sweep throws: an unhandled rejection
    // here would stop expiry for the life of the process, which is exactly the
    // silent, symptomless failure this whole file exists to prevent.
    log.db.error({ err: error }, '[Expiry] sweep failed');
  }
}

/**
 * Start the sweep.
 *
 * THIS is the half `@oxyhq/db` cannot supply, and the half whose absence is
 * undetectable from the registry above. It runs on every task: the sweep is
 * idempotent and bounded, so several tasks running it concurrently costs a
 * little duplicated work and nothing else.
 */
export function startExpirySweeper(): void {
  if (timer !== null) return;

  timer = setInterval(() => {
    // One sweep at a time per task. Overlapping runs would contend for the
    // same rows without draining any faster.
    if (inFlight) return;
    inFlight = runOnce().finally(() => {
      inFlight = null;
    });
  }, SWEEP_INTERVAL_MS);
  // A housekeeping interval must never hold the event loop open — an
  // un-unref'd timer hangs the test runner non-deterministically.
  timer.unref?.();

  log.db.info(
    { intervalMs: SWEEP_INTERVAL_MS, targets: EXPIRY_TARGETS.length },
    '[Expiry] sweeper started',
  );
}

/** Stop sweeping and let the run in flight finish. */
export async function stopExpirySweeper(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  await inFlight;
}

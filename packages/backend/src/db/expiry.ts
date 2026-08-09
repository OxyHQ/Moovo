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
 * `ExpirySweepTarget` is `{table, column, retentionSeconds}` — there is no
 * predicate field, so a partial filter has nowhere to live as a sweep
 * argument. Both are therefore folded into a GENERATED COLUMN on the table
 * itself (`notifications.dismissedSince`, `jobOffers.reapableSince`), which
 * is NULL for any row that must not be reaped. `NULL <= now() - interval` is
 * never true, so the filter cannot be omitted by a caller — there is no
 * argument to omit. See those columns' own comments for the full reasoning.
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
    column: jobOffers.reapableSince,
    retentionSeconds: DEADLINE_IS_THE_COLUMN,
    reason:
      'A settled offer (accepted, declined, expired or superseded) is dispatch ' +
      'bookkeeping, not history — the job carries the outcome. A STILL-OFFERED ' +
      'row is never reaped: `reapableSince` is NULL until the semantic flip ' +
      'moves it out of `offered`.',
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

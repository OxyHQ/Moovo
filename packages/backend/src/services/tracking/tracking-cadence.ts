/**
 * When to ask a carrier again — the function that decides what this product
 * costs.
 *
 * A flat cron over every parcel would spend roughly ten times what this does
 * for a worse answer: a parcel sitting in a warehouse for three days does not
 * need asking every twenty minutes, and one that is out for delivery does.
 *
 * The table is exported so a test can iterate `TRACKING_STATUSES` and fail on
 * any status without an entry. That direction matters: a `default` branch would
 * silently give a newly added status some arbitrary cadence, and the symptom
 * would be a cost or a latency nobody can trace back to a missing line.
 */

import { config } from '../../config/index.js';
import type { TrackingPollMode, TrackingStatus } from '@moovo/shared-types';
import { isTerminalTrackingStatus } from './tracking-status.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * How long to wait before asking again, by status.
 *
 * `fresh` applies while the last checkpoint is recent, `stale` once it is not:
 * a parcel that moved an hour ago is in an active leg and worth watching, while
 * one that last moved three days ago is in a queue somewhere and is not.
 * `null` means never ask again.
 */
export const TRACKING_CADENCE: Readonly<
  Record<TrackingStatus, { fresh: number; stale: number; freshWindowMs: number } | null>
> = Object.freeze({
  /** Never fetched successfully. The first attempt is scheduled immediately. */
  pending: { fresh: 0, stale: 0, freshWindowMs: 0 },
  info_received: { fresh: 6 * HOUR, stale: 12 * HOUR, freshWindowMs: 24 * HOUR },
  in_transit: { fresh: 3 * HOUR, stale: 8 * HOUR, freshWindowMs: 48 * HOUR },
  /** The state people open the app for, and the only one worth minutes. */
  out_for_delivery: { fresh: 20 * MINUTE, stale: 20 * MINUTE, freshWindowMs: 0 },
  available_for_pickup: { fresh: 12 * HOUR, stale: 12 * HOUR, freshWindowMs: 0 },
  failed_attempt: { fresh: 2 * HOUR, stale: 6 * HOUR, freshWindowMs: 24 * HOUR },
  exception: { fresh: 6 * HOUR, stale: 12 * HOUR, freshWindowMs: 48 * HOUR },
  delivered: null,
  returned: null,
  expired: null,
  cancelled: null,
});

export interface CadenceInput {
  status: TrackingStatus;
  pollMode: TrackingPollMode;
  subscriberCount: number;
  lastCheckpointAt: Date | null;
  now: Date;
  /** Injected so a test is not at the mercy of `Math.random`. */
  random?: () => number;
}

/**
 * Jitter, ±15%.
 *
 * Without it every parcel added during one marketing push comes due in the same
 * second — and keeps doing so forever, because each new due time is computed
 * from the last. The spread is the difference between a smooth call rate and a
 * spike that trips a carrier's rate limit on the hour, every hour.
 */
function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.85 + random() * 0.3));
}

/**
 * The next due time, or `null` for "never ask again".
 *
 * The three `null` cases are different claims and it is worth keeping them
 * distinct in the reading: terminal means there is no answer left to get,
 * unwatched means nobody is paying attention so the answer is not worth buying,
 * and deep-link means we have no way to ask at all.
 */
export function nextPollAt(input: CadenceInput): Date | null {
  const random = input.random ?? Math.random;

  // We cannot call this carrier. The CHECK constraint enforces the same thing
  // at the database, so this is the polite half of a rule that is not optional.
  if (input.pollMode === 'deeplink') return null;

  // Polling gave up, or never applied. Only an explicit refresh revives it.
  if (input.pollMode === 'manual') return null;

  if (isTerminalTrackingStatus(input.status)) return null;

  // Nobody is watching. The row stays as a cache for the next lookup, but it
  // stops costing anything — this is what makes an anonymous lookup exactly one
  // carrier call. Re-armed by the next subscribe.
  if (input.subscriberCount <= 0) return null;

  const entry = TRACKING_CADENCE[input.status];
  if (entry === null) return null;

  const ageMs =
    input.lastCheckpointAt === null
      ? Number.POSITIVE_INFINITY
      : input.now.getTime() - input.lastCheckpointAt.getTime();
  const base = ageMs <= entry.freshWindowMs ? entry.fresh : entry.stale;

  // A webhook carrier still polls, far more slowly. The push is the mechanism;
  // this is the reconciliation backstop, and it is never `null` — a feed that
  // stops silently is precisely the case a backstop exists for. Same argument
  // `job_offers` uses for sweeping unconditionally.
  const scaled = input.pollMode === 'webhook' ? base * 8 : base;

  return new Date(input.now.getTime() + (scaled === 0 ? 0 : jitter(scaled, random)));
}

/**
 * Backoff after a carrier error — the same curve and the same ceiling as the
 * moderation outbox, because it is the same problem.
 *
 * Deliberately NOT re-derived from that module's constants by import: those are
 * a delivery schedule for a third party's webhook endpoint and these are a
 * fetch schedule for a carrier API. They agree today and are free to diverge,
 * so the shape is copied and the reason written down rather than the coupling
 * being made real.
 */
export function failureBackoffMs(consecutiveFailures: number): number {
  const attempt = Math.max(1, consecutiveFailures);
  return Math.min(SECOND * 2 ** (attempt - 1), 6 * HOUR);
}

/**
 * Whether a run of not-founds has gone on long enough, and for long enough, to
 * call the number dead.
 *
 * Both conditions, and the second is the one that is easy to leave out: ten
 * fast retries inside an hour say nothing at all about a label that was created
 * this morning and has not reached a depot yet.
 */
export function shouldExpireNotFound(input: {
  notFoundStreak: number;
  createdAt: Date;
  now: Date;
}): boolean {
  return (
    input.notFoundStreak >= config.tracking.maxNotFoundStreak &&
    input.now.getTime() - input.createdAt.getTime() >= config.tracking.notFoundMinAgeMs
  );
}

/** Whether a parcel has gone quiet long enough to be called `expired`. */
export function isStale(input: { lastCheckpointAt: Date | null; createdAt: Date; now: Date }): boolean {
  const reference = input.lastCheckpointAt ?? input.createdAt;
  return input.now.getTime() - reference.getTime() >= config.tracking.staleAfterMs;
}

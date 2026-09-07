/**
 * How many calls a carrier will take from us this minute.
 *
 * Every carrier publishes a rate limit, and the free tiers are tight. Exceeding
 * one does not fail loudly and locally — it gets an API key throttled or
 * revoked, hours later, for every parcel on that carrier at once.
 *
 * ## The honest limitation, stated here rather than glossed in a comment
 *
 * With Redis the bucket is shared, so the budget is exact however many tasks
 * are running. Without it the bucket is per PROCESS, so N tasks can spend N
 * times the budget. Moovo runs one task today, so it is exact today — and it
 * will stop being exact silently, the first time the service scales out. That
 * is a real gap and it belongs in the reading, not in a footnote: the fix is
 * `REDIS_URL`, and `getRedisClient()` returning null is the signal.
 */

import { getRedisClient } from '../../lib/redis.js';
import { log } from '../../lib/logger.js';

/** Per-process fallback buckets, keyed by `carrier:minute`. */
const localBuckets = new Map<string, number>();
let localBucketMinute = -1;

function currentMinute(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}

/**
 * How many calls remain for this carrier in the current minute.
 *
 * `null` for `maxCallsPerMinute` means unlimited, which is the right default
 * for a carrier nobody has measured: a made-up ceiling would throttle a feed
 * that was fine and the symptom would be parcels updating slowly for no
 * visible reason.
 */
export async function remainingBudget(
  carrierKey: string,
  maxCallsPerMinute: number | null,
  now: Date = new Date(),
): Promise<number> {
  if (maxCallsPerMinute === null || maxCallsPerMinute <= 0) return Number.POSITIVE_INFINITY;

  const minute = currentMinute(now);
  const redis = getRedisClient();

  if (redis) {
    try {
      const key = `tracking:budget:${carrierKey}:${minute}`;
      const spent = await redis.get(key);
      return Math.max(0, maxCallsPerMinute - Number(spent ?? 0));
    } catch (error: unknown) {
      // A Redis blip must not stop the poller: falling back to the local bucket
      // spends at most one task's worth of budget, which is the same failure
      // mode as running without Redis at all.
      log.general.warn({ err: error, carrierKey }, '[Tracking] budget read failed; using local bucket');
    }
  }

  if (localBucketMinute !== minute) {
    localBuckets.clear();
    localBucketMinute = minute;
  }
  return Math.max(0, maxCallsPerMinute - (localBuckets.get(carrierKey) ?? 0));
}

/** Record one call against a carrier's budget. */
export async function spendBudget(
  carrierKey: string,
  maxCallsPerMinute: number | null,
  now: Date = new Date(),
): Promise<void> {
  if (maxCallsPerMinute === null || maxCallsPerMinute <= 0) return;

  const minute = currentMinute(now);
  const redis = getRedisClient();

  if (redis) {
    try {
      const key = `tracking:budget:${carrierKey}:${minute}`;
      // INCR then EXPIRE: the key is per-minute, so a missed EXPIRE leaks one
      // small key rather than blocking the carrier forever.
      await redis.incr(key);
      await redis.expire(key, 120);
      return;
    } catch (error: unknown) {
      log.general.warn(
        { err: error, carrierKey },
        '[Tracking] budget write failed; using local bucket',
      );
    }
  }

  if (localBucketMinute !== minute) {
    localBuckets.clear();
    localBucketMinute = minute;
  }
  localBuckets.set(carrierKey, (localBuckets.get(carrierKey) ?? 0) + 1);
}

/** Reset the in-process buckets. Tests only. */
export function __resetBudgetsForTests(): void {
  localBuckets.clear();
  localBucketMinute = -1;
}

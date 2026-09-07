/**
 * The loop that keeps tracked parcels current.
 *
 * Runs on EVERY task, not on a leader, exactly as the moderation dispatcher
 * does: claims are Postgres leases with an owner check, so N tasks share the
 * work safely and a dead task's parcel is reclaimed once its lease lapses.
 * Leader election would add a failure mode — no leader, no tracking — for no
 * benefit the lease does not already provide.
 *
 * Not BullMQ, and that is a decision rather than an omission: BullMQ only runs
 * when `REDIS_URL` is set, and its fallback is "run the handler inline in the
 * producer". There is no producer here, there is a clock. A tracker that
 * silently stops polling on a deployment without Redis is the worst available
 * failure shape — every table keeps filling, no checkpoint ever arrives, and
 * the symptom reads as every carrier being down at once.
 */

import { sql } from 'drizzle-orm';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { log } from '../../lib/logger.js';
import { randomUUID } from 'node:crypto';
import {
  claimDueParcel,
  refreshSubscriberCount,
  releaseParcelLease,
  renewParcelLease,
} from '../../db/tracking/trackedParcelRepository.js';
import {
  listEnabledTrackingCarriers,
  type TrackingCarrierRow,
} from '../../db/tracking/trackingCarrierRepository.js';
import { remainingBudget } from './carrier-budget.js';
import { listFetchingTrackingAdapters } from './tracking-registry.js';
import { pollParcel, type PollOutcome } from './tracking-poll.service.js';
import { announceParcelChange } from './tracking-events.service.js';

let timer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;
let inFlight: Promise<void> | null = null;
let ticks = 0;

/** The identity this process claims leases under. */
const leaseOwner = `tracking-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Keep a lease alive while a carrier is slow.
 *
 * At a third of the lease, so two heartbeats can be missed before another task
 * reclaims the parcel.
 */
function startLeaseHeartbeat(parcelId: string): () => void {
  const interval = setInterval(() => {
    void renewParcelLease(parcelId, leaseOwner, config.tracking.leaseMs).then((held) => {
      if (!held) {
        log.general.warn({ parcelId }, '[Tracking] lease lost while polling');
      }
    });
  }, Math.max(1_000, Math.floor(config.tracking.leaseMs / 3)));
  interval.unref?.();
  return () => clearInterval(interval);
}

/** Carriers that can be called AND still have budget left this minute. */
async function carriersWithBudget(): Promise<Map<string, TrackingCarrierRow>> {
  const carriers = await listEnabledTrackingCarriers();
  const fetching = new Set(listFetchingTrackingAdapters().map((adapter) => adapter.key));
  const withBudget = new Map<string, TrackingCarrierRow>();

  for (const carrier of carriers) {
    if (!carrier.pollSupported || !fetching.has(carrier.key)) continue;
    // Computed BEFORE the claim. Claiming and then releasing an over-budget
    // parcel would burn a lease cycle and reorder the queue.
    if ((await remainingBudget(carrier.key, carrier.maxCallsPerMinute)) <= 0) continue;
    withBudget.set(carrier.key, carrier);
  }
  return withBudget;
}

/** One tick: claim up to `batchSize` due parcels and poll each. */
export async function runTrackingPollBatch(signal: AbortSignal): Promise<PollOutcome[]> {
  const outcomes: PollOutcome[] = [];

  for (let claimed = 0; claimed < config.tracking.batchSize; claimed += 1) {
    if (signal.aborted) break;

    const carriers = await carriersWithBudget();
    if (carriers.size === 0) break;

    const parcel = await claimDueParcel({
      leaseOwner,
      leaseMs: config.tracking.leaseMs,
      carrierKeys: [...carriers.keys()],
    });
    if (!parcel) break;

    const carrier = carriers.get(parcel.carrierKey);
    if (!carrier) {
      await releaseParcelLease(parcel.id, leaseOwner);
      continue;
    }

    const stopHeartbeat = startLeaseHeartbeat(parcel.id);
    const timeout = AbortSignal.timeout(config.tracking.fetchTimeoutMs);
    try {
      const outcome = await pollParcel(parcel, carrier, AbortSignal.any([signal, timeout]));
      outcomes.push(outcome);
      if (outcome.result === 'updated') {
        // Best-effort: a notification failure is logged inside and never
        // reaches here, because it must not undo a poll that already committed.
        await announceParcelChange(parcel, outcome);
      }
    } catch (error: unknown) {
      // `pollParcel` handles carrier errors itself, so anything arriving here
      // is a bug in the write-back path. The lease is dropped so the parcel is
      // reclaimable immediately rather than after the lease lapses.
      log.general.error({ err: error, parcelId: parcel.id }, '[Tracking] poll failed unexpectedly');
      await releaseParcelLease(parcel.id, leaseOwner);
    } finally {
      // Stopped BEFORE any further transition, so a heartbeat cannot re-extend
      // a lease the outcome has already released.
      stopHeartbeat();
    }
  }

  return outcomes;
}

/**
 * The backstop for the one denormalised counter.
 *
 * `subscriber_count` drives scheduling, not correctness, and this is what makes
 * that claim true: any parcel whose counter disagrees with its subscriptions
 * gets recounted and re-armed. Without it a parcel could sit with subscribers
 * and no due time — watched, and silently never updated.
 */
async function reconcile(): Promise<void> {
  const rows = await getDb().execute<{ id: string }>(sql`
    select p.id
    from tracked_parcels p
    left join tracked_parcel_subscriptions s on s.parcel_id = p.id
    group by p.id, p.subscriber_count
    having count(s.id)::int <> p.subscriber_count
    limit 100
  `);

  for (const row of rows) {
    await refreshSubscriberCount(row.id, null);
    log.general.warn({ parcelId: row.id }, '[Tracking] subscriber count reconciled');
  }
}

async function runOnce(signal: AbortSignal): Promise<void> {
  try {
    const outcomes = await runTrackingPollBatch(signal);
    if (outcomes.length > 0) {
      log.general.debug(
        { polled: outcomes.length, updated: outcomes.filter((o) => o.result === 'updated').length },
        '[Tracking] poll batch complete',
      );
    }

    ticks += 1;
    if (ticks % 20 === 0) await reconcile();
  } catch (error: unknown) {
    // The loop must survive anything a batch throws: an unhandled rejection
    // here would stop tracking for the life of the process, and nothing would
    // say so.
    log.general.error({ err: error }, '[Tracking] poll batch failed');
  }
}

export function startTrackingPollDispatcher(): void {
  if (timer !== null) return;

  // BOTH halves, like `crowdSourceEnabled`. A poller enabled with no fetching
  // adapter is a timer that claims every due parcel and fails it into backoff,
  // which from outside looks exactly like every carrier being down at once.
  if (!config.tracking.enabled) {
    log.general.info('[Tracking] poll dispatcher not started: TRACKING_ENABLED is false');
    return;
  }
  if (listFetchingTrackingAdapters().length === 0) {
    log.general.info(
      '[Tracking] poll dispatcher not started: no carrier adapter can fetch in this build',
    );
    return;
  }

  controller = new AbortController();
  const signal = controller.signal;

  timer = setInterval(() => {
    // One batch at a time per task: overlapping runs would double the claim
    // pressure without draining any faster.
    if (inFlight) return;
    inFlight = runOnce(signal).finally(() => {
      inFlight = null;
    });
  }, config.tracking.pollIntervalMs);
  timer.unref?.();

  log.general.info(
    { intervalMs: config.tracking.pollIntervalMs, leaseOwner },
    '[Tracking] poll dispatcher started',
  );
}

/** Stop claiming new work and let the batch in flight reach a durable state. */
export async function stopTrackingPollDispatcher(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  controller?.abort();
  controller = null;
  await inFlight;
}

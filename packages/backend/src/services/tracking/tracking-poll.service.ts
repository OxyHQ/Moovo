/**
 * One parcel, fetched and written back.
 *
 * This is the only place a carrier is called and the only place checkpoints are
 * written. That singularity is deliberate: the webhook route does NOT parse and
 * ingest inline, it sets `next_poll_at = now()` and lets this function do it, so
 * there is exactly one ingest path, one dedupe implementation and one
 * notification fan-out. Two writers of a timeline drift.
 *
 * Every outcome releases the lease. A parcel left leased is invisible to the
 * claim query until its lease lapses, which turns a bug here into a parcel that
 * silently stops updating for a minute — the kind of thing nobody reports and
 * nobody can reproduce.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  applyParcelSnapshot,
  failParcelPoll,
  recordParcelNotFound,
  type TrackedParcelRow,
} from '../../db/tracking/trackedParcelRepository.js';
import { ingestCheckpoints } from '../../db/tracking/trackingCheckpointRepository.js';
import type { TrackingCarrierRow } from '../../db/tracking/trackingCarrierRepository.js';
import { getTrackingAdapter } from './tracking-registry.js';
import {
  failureBackoffMs,
  isStale,
  nextPollAt,
  shouldExpireNotFound,
} from './tracking-cadence.js';
import { spendBudget } from './carrier-budget.js';
import type { TrackingPollMode, TrackingStatus } from '@moovo/shared-types';
import type { TrackingSnapshot } from './tracking-adapter.js';

/** What one poll did, for the dispatcher's log and for the notification step. */
export interface PollOutcome {
  parcelId: string;
  result: 'updated' | 'unchanged' | 'not_found' | 'failed' | 'skipped';
  previousStatus: TrackingStatus;
  status: TrackingStatus;
  newCheckpointIds: string[];
  latestCheckpointAt: Date | null;
}

function due(parcel: TrackedParcelRow, status: TrackingStatus, lastCheckpointAt: Date | null) {
  return nextPollAt({
    status,
    pollMode: parcel.pollMode as TrackingPollMode,
    subscriberCount: parcel.subscriberCount,
    lastCheckpointAt,
    now: new Date(),
  });
}

/**
 * Fetch one parcel and write back whatever came of it.
 *
 * The caller owns the lease; this owns the outcome.
 */
export async function pollParcel(
  parcel: TrackedParcelRow,
  carrier: TrackingCarrierRow,
  signal: AbortSignal,
): Promise<PollOutcome> {
  const previousStatus = parcel.status as TrackingStatus;
  const adapter = getTrackingAdapter(parcel.carrierKey);

  if (!adapter?.fetch) {
    // The carrier lost its adapter between the claim and here — a deploy that
    // removed one, most likely. Dropping to `manual` stops the parcel spinning
    // through the claim loop, and leaves it readable and refreshable.
    await failParcelPoll(parcel.id, {
      nextPollAt: null,
      lastPollError: `No fetching adapter registered for carrier ${parcel.carrierKey}`,
      pollMode: 'manual',
    });
    return {
      parcelId: parcel.id,
      result: 'skipped',
      previousStatus,
      status: previousStatus,
      newCheckpointIds: [],
      latestCheckpointAt: parcel.lastCheckpointAt,
    };
  }

  let snapshot: TrackingSnapshot;
  try {
    await spendBudget(carrier.key, carrier.maxCallsPerMinute);
    snapshot = await adapter.fetch({
      trackingNumber: parcel.trackingNumber,
      ...(parcel.destinationPostalCode
        ? { destinationPostalCode: parcel.destinationPostalCode }
        : {}),
      ...(parcel.destinationCountry ? { destinationCountry: parcel.destinationCountry } : {}),
      signal,
    });
  } catch (error: unknown) {
    return await recordFailure(parcel, previousStatus, error);
  }

  if (snapshot.notFound) {
    return await recordNotFound(parcel, previousStatus);
  }

  return await applySnapshot(parcel, previousStatus, snapshot);
}

async function recordFailure(
  parcel: TrackedParcelRow,
  previousStatus: TrackingStatus,
  error: unknown,
): Promise<PollOutcome> {
  const failures = parcel.consecutiveFailures + 1;
  const message = error instanceof Error ? error.message : String(error);

  // Dead-lettering as a MODE change rather than a status change: the parcel is
  // still readable and still refreshable by hand, it just stops being claimed.
  // Making it a status would tell the user their parcel is "expired" when what
  // expired is our patience with the carrier.
  const exhausted = failures >= config.tracking.maxConsecutiveFailures;
  await failParcelPoll(parcel.id, {
    nextPollAt: exhausted ? null : new Date(Date.now() + failureBackoffMs(failures)),
    lastPollError: message,
    ...(exhausted ? { pollMode: 'manual' } : {}),
  });

  if (exhausted) {
    log.general.error(
      { parcelId: parcel.id, carrierKey: parcel.carrierKey, failures, err: error },
      '[Tracking] parcel dropped to manual after repeated carrier failures',
    );
  }

  return {
    parcelId: parcel.id,
    result: 'failed',
    previousStatus,
    status: previousStatus,
    newCheckpointIds: [],
    latestCheckpointAt: parcel.lastCheckpointAt,
  };
}

async function recordNotFound(
  parcel: TrackedParcelRow,
  previousStatus: TrackingStatus,
): Promise<PollOutcome> {
  const streak = parcel.notFoundStreak + 1;
  const expired = shouldExpireNotFound({
    notFoundStreak: streak,
    createdAt: parcel.createdAt,
    now: new Date(),
  });

  const status: TrackingStatus = expired ? 'expired' : previousStatus;
  await recordParcelNotFound(parcel.id, {
    nextPollAt: expired ? null : due(parcel, status, parcel.lastCheckpointAt),
    ...(expired ? { status } : {}),
  });

  return {
    parcelId: parcel.id,
    result: 'not_found',
    previousStatus,
    status,
    newCheckpointIds: [],
    latestCheckpointAt: parcel.lastCheckpointAt,
  };
}

async function applySnapshot(
  parcel: TrackedParcelRow,
  previousStatus: TrackingStatus,
  snapshot: TrackingSnapshot,
): Promise<PollOutcome> {
  const latestFromCarrier = snapshot.checkpoints.reduce<Date | null>(
    (latest, checkpoint) =>
      latest === null || checkpoint.occurredAt > latest ? checkpoint.occurredAt : latest,
    null,
  );
  const lastCheckpointAt = latestFromCarrier ?? parcel.lastCheckpointAt;

  // A parcel the carrier still answers about but has said nothing new about for
  // two months is finished as far as anyone is concerned. Without this it polls
  // forever at the stale cadence.
  const stale =
    !snapshot.deliveredAt &&
    isStale({ lastCheckpointAt, createdAt: parcel.createdAt, now: new Date() });
  const status: TrackingStatus = stale ? 'expired' : snapshot.status;

  const { newIds, total } = await getDb().transaction(async (tx) => {
    const inserted = await ingestCheckpoints(
      parcel.id,
      snapshot.checkpoints.map((checkpoint) => ({
        occurredAt: checkpoint.occurredAt,
        occurredAtIsLocal: checkpoint.occurredAtIsLocal ?? false,
        status: checkpoint.status,
        rawStatus: checkpoint.rawStatus ?? null,
        description: checkpoint.description ?? null,
        locationText: checkpoint.locationText ?? null,
        countryCode: checkpoint.countryCode ?? null,
        latitude: checkpoint.location?.coordinates[1] ?? null,
        longitude: checkpoint.location?.coordinates[0] ?? null,
      })),
      tx,
    );

    await applyParcelSnapshot(
      parcel.id,
      parcel.subscriberCount,
      {
        status,
        rawStatus: snapshot.rawStatus ?? null,
        serviceName: snapshot.serviceName ?? null,
        originCountry: snapshot.originCountry ?? null,
        destinationCountry: snapshot.destinationCountry ?? parcel.destinationCountry,
        estimatedDeliveryAt: snapshot.estimatedDeliveryAt ?? null,
        deliveredAt: snapshot.deliveredAt ?? null,
        lastCheckpointAt,
        checkpointCount: parcel.checkpointCount + inserted.length,
        nextPollAt: due(parcel, status, lastCheckpointAt),
      },
      tx,
    );

    return { newIds: inserted.map((row) => row.id), total: inserted.length };
  });

  return {
    parcelId: parcel.id,
    result: total > 0 || status !== previousStatus ? 'updated' : 'unchanged',
    previousStatus,
    status,
    newCheckpointIds: newIds,
    latestCheckpointAt: lastCheckpointAt,
  };
}

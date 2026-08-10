/**
 * Real-time dispatch service (Glovo-style offer fan-out).
 *
 * `dispatchJob` selects up to `config.dispatch.waveSize` nearby ONLINE eligible
 * couriers around the job's pickup (an `ST_DWithin` query ordered by distance
 * over `courier_profiles.location`, nearest-first), creates one time-boxed
 * offer per candidate, moves the job `requested → offered` on the FIRST wave
 * (a guarded transition so later waves — already `offered` — skip it), bumps the
 * job's `dispatchAttempts` wave counter, and pushes a `job:offer` socket event +
 * best-effort `job_offered` notification to each candidate.
 *
 * On each re-dispatch wave the radius WIDENS (`radiusM * wave`, 1-based) and
 * couriers who already hold a non-terminal offer for this job — and the assigned
 * courier — are EXCLUDED so a courier is never offered the same job twice.
 *
 * ZERO candidates is NOT a failure: the job is left `requested` and the
 * offer-expiry sweep retries on its next pass. Best-effort throughout — a booking
 * never fails because dispatch did; the sweep recovers.
 *
 * The job.service ↔ dispatch.service cycle is broken with a dynamic `import` of
 * `job.service` inside the wave-1 transition (same technique as `queue/handlers`).
 */

import type { JobOfferView, FiatCurrency, JobType, SizeClass } from '@moovo/shared-types';
import { findJobById, setDispatchAttempts } from '../db/transport/jobRepository.js';
import type { JobRecord } from '../db/transport/jobShape.js';
import {
  insertJobOffer,
  listCourierIdsWithLiveOffer,
} from '../db/transport/jobOfferRepository.js';
import {
  findDispatchCandidates,
  type CourierProfileRow,
} from '../db/fleet/courierProfileRepository.js';
import { isEligible } from './capability.service.js';
import { getFairRate } from './faircoin-rate.service.js';
import { toDisplayPriceBreakdown } from '../utils/fair-display.js';
import { distanceMetersBetween } from '../utils/geo.js';
import { config } from '../config/index.js';
import { EVENTS } from '../lib/socket-events.js';
import { getIO } from '../socket.js';
import { sendNotification } from '../lib/notification-service.js';
import { log } from '../lib/logger.js';

/** Currency the offer's display totals are converted to (couriers are EUR-priced). */
const OFFER_DISPLAY_CURRENCY: FiatCurrency = 'EUR';

/** The result of a dispatch wave. */
export interface DispatchResult {
  /** Number of offers created this wave. */
  offered: number;
  /** The 1-based wave number that ran (the job's `dispatchAttempts` after the bump). */
  wave: number;
}

/** Fire a notification, swallowing (and warning on) any failure. NEVER throws. */
async function notifySafe(options: Parameters<typeof sendNotification>[0]): Promise<void> {
  try {
    await sendNotification(options);
  } catch (err) {
    log.general.warn(
      { err, userId: options.userId, type: options.type },
      'Dispatch offer notification failed (best-effort)',
    );
  }
}

/**
 * The pickup coordinates of a job, or null when malformed.
 *
 * The ordinates are NOT NULL columns now, so the malformed case is
 * unreachable through the repository — the guard stays because it is cheap and
 * because deleting it would make a future nullable column silently dispatch
 * every job from (0, 0).
 */
function pickupCoordinates(job: JobRecord): [number, number] | null {
  const coords = job.pickupSnapshot.location.coordinates;
  if (coords.length < 2) {
    return null;
  }
  return [coords[0], coords[1]];
}

/**
 * Find up to `waveSize` nearby ONLINE eligible couriers around the pickup,
 * nearest-first, excluding `excludeIds`. The geo + capacity gate runs in SQL;
 * the precise `isEligible` capability check runs per-candidate on the projected
 * denormalized capability (size class is not an orderable column).
 */
async function findCandidates(
  job: JobRecord,
  pickup: [number, number],
  radiusM: number,
  excludeIds: string[],
): Promise<CourierProfileRow[]> {
  const candidates = await findDispatchCandidates({
    pickup: { longitude: pickup[0], latitude: pickup[1] },
    radiusM,
    jobType: job.type,
    weightKg: job.parcelSnapshot.weightKg,
    stalePingCutoff: new Date(Date.now() - config.dispatch.stalenessMs),
    excludeOxyUserIds: excludeIds,
    limit: config.dispatch.waveSize,
  });

  // Final precise capability gate (size class ordering is not a SQL range).
  return candidates.filter((c) =>
    isEligible(
      {
        eligibleJobTypes: c.eligibleJobTypes as JobType[],
        maxSizeClass: c.maxSizeClass as SizeClass,
        maxWeightKg: c.maxWeightKg,
      },
      {
        jobType: job.type,
        sizeClass: job.parcelSnapshot.sizeClass,
        weightKg: job.parcelSnapshot.weightKg,
      },
    ),
  );
}

/** Build the compact `JobOfferView` pushed to a candidate over `job:offer`. */
async function buildOfferView(
  job: JobRecord,
  offerId: string,
  distanceM: number,
  expiresAt: Date,
): Promise<JobOfferView> {
  const rate = await getFairRate(OFFER_DISPLAY_CURRENCY);
  return {
    offerId,
    jobId: job.id,
    shipmentId: job.shipmentId,
    type: job.type,
    pickupCity: job.pickupSnapshot.address.city,
    dropoffCity: job.dropoffSnapshot.address.city,
    sizeClass: job.parcelSnapshot.sizeClass,
    totals: toDisplayPriceBreakdown(job.totals, rate),
    distanceM,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Dispatch (or re-dispatch) a job to a fresh wave of nearby couriers. Loads the
 * job NON-lean, widens the radius per wave, excludes prior + assigned couriers,
 * creates the offers, transitions wave-1 jobs `requested → offered`, bumps
 * `dispatchAttempts`, and fans out the `job:offer` event + notification.
 */
export async function dispatchJob(jobId: string): Promise<DispatchResult> {
  let job = await findJobById(jobId);
  if (!job) {
    log.general.warn({ jobId }, 'Dispatch skipped: job not found');
    return { offered: 0, wave: 0 };
  }
  if (job.fulfillmentType !== 'moovo_courier') {
    return { offered: 0, wave: job.dispatchAttempts };
  }
  if (job.status !== 'requested' && job.status !== 'offered') {
    // Already accepted/picked up/terminal — nothing to dispatch.
    return { offered: 0, wave: job.dispatchAttempts };
  }

  const pickup = pickupCoordinates(job);
  if (!pickup) {
    log.general.warn({ jobId }, 'Dispatch skipped: job has no pickup coordinates');
    return { offered: 0, wave: job.dispatchAttempts };
  }

  // 1-based wave number for THIS dispatch (the count after this attempt).
  const wave = job.dispatchAttempts + 1;
  const radiusM = config.dispatch.radiusM * wave;

  // Exclude anyone already holding a live offer for this job — a courier is
  // never offered the same job twice across waves — plus the assigned courier.
  const excludeIds = await listCourierIdsWithLiveOffer(jobId);
  if (job.courierOxyUserId) {
    excludeIds.push(job.courierOxyUserId);
  }

  const candidates = await findCandidates(job, pickup, radiusM, excludeIds);

  // Always record that a wave was attempted (so the sweep can cap re-dispatch).
  await setDispatchAttempts(job.id, wave);
  job = { ...job, dispatchAttempts: wave };

  if (candidates.length === 0) {
    log.general.info({ jobId, wave, radiusM }, 'Dispatch wave found no candidates — leaving requested');
    return { offered: 0, wave };
  }

  // On the FIRST wave move the job requested → offered (guarded so a re-dispatch
  // wave, already `offered`, never errors on a re-transition). The dynamic import
  // breaks the job.service ↔ dispatch.service module cycle.
  if (job.status === 'requested') {
    const { transition } = await import('./job.service.js');
    try {
      job = await transition(job, 'offered', { note: 'dispatched to couriers' });
    } catch (err) {
      // A concurrent accept/cancel won the race — abandon this wave cleanly.
      log.general.warn({ err, jobId }, 'Dispatch wave aborted: job changed status during transition');
      return { offered: 0, wave };
    }
  }

  const offeredAt = new Date();
  const expiresAt = new Date(offeredAt.getTime() + config.dispatch.offerTtlMs);

  let offered = 0;
  for (let rank = 0; rank < candidates.length; rank += 1) {
    const candidate = candidates[rank];
    const courierOxyUserId = candidate.oxyUserId;
    // The ordinates are columns now, not a nested GeoJSON point. A candidate
    // reached here through `ST_DWithin`, so both are set — but the fallback is
    // kept because the columns are nullable and `radiusM` is the honest upper
    // bound for a courier whose position we cannot read.
    const distanceM =
      candidate.longitude !== null && candidate.latitude !== null
        ? distanceMetersBetween([candidate.longitude, candidate.latitude], pickup)
        : radiusM;

    /**
     * Each offer is its own autocommit statement, deliberately NOT one
     * transaction around the wave: the source created them one at a time and
     * skipped a candidate whose creation failed. Inside a transaction, one
     * failed insert aborts it and every LATER candidate fails too — the catch
     * below would run and log a per-candidate warning while silently offering
     * the job to nobody.
     */
    try {
      const created = await insertJobOffer({
        jobId: job.id,
        shipmentId: job.shipmentId,
        courierOxyUserId,
        companyId: job.companyId,
        offeredAt,
        expiresAt,
        rank,
        distanceM,
      });
      offered += 1;

      const view = await buildOfferView(job, created.id, distanceM, expiresAt);
      getIO()?.to(`user:${courierOxyUserId}`).emit(EVENTS.JOB_OFFER, view);
      await notifySafe({
        userId: courierOxyUserId,
        type: 'job_offered',
        title: 'New job offer',
        body: `A ${job.type} job near ${job.pickupSnapshot.address.city} is available.`,
        data: { jobId: job.id, offerId: created.id, expiresAt: expiresAt.toISOString() },
      });
    } catch (err) {
      log.general.warn({ err, jobId, courierOxyUserId }, 'Failed to create/emit a job offer (skipping candidate)');
    }
  }

  log.general.info({ jobId, wave, radiusM, offered }, 'Dispatched job offers');
  return { offered, wave };
}

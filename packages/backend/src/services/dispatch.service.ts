/**
 * Real-time dispatch service (Glovo-style offer fan-out).
 *
 * `dispatchJob` selects up to `config.dispatch.waveSize` nearby ONLINE eligible
 * couriers around the job's pickup (a `$nearSphere` geo-query over
 * `CourierProfile.currentLocation`, nearest-first), creates one time-boxed
 * `JobOffer` per candidate, moves the job `requested → offered` on the FIRST wave
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

import type { JobOfferView, FiatCurrency } from '@moovo/shared-types';
import { Job, type IJob } from '../models/job.js';
import { JobOffer, NON_TERMINAL_OFFER_STATUSES } from '../models/job-offer.js';
import { CourierProfile, type ICourierProfile } from '../models/courier-profile.js';
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

/** The pickup coordinates of a job, or null when malformed. */
function pickupCoordinates(job: IJob): [number, number] | null {
  const coords = job.pickupSnapshot?.location?.coordinates;
  if (!coords || coords.length < 2) {
    return null;
  }
  return [coords[0], coords[1]];
}

/**
 * Courier oxy ids that must be EXCLUDED from this job's next wave: anyone who
 * already holds a non-terminal (`offered`) offer for this job. The assigned
 * courier (when set) is excluded by the caller.
 */
async function couriersWithLiveOffer(jobId: string): Promise<string[]> {
  const offers = await JobOffer.find({
    jobId,
    status: { $in: [...NON_TERMINAL_OFFER_STATUSES] },
  })
    .select({ courierOxyUserId: 1 })
    .lean<{ courierOxyUserId: string }[]>();
  return offers.map((o) => String(o.courierOxyUserId));
}

/**
 * Find up to `waveSize` nearby ONLINE eligible couriers around the pickup,
 * nearest-first, excluding `excludeIds`. The geo + capacity gate runs in Mongo;
 * the precise `isEligible` capability check runs per-candidate on the projected
 * denormalized capability (size class is not expressible as a simple Mongo range).
 */
async function findCandidates(
  job: IJob,
  pickup: [number, number],
  radiusM: number,
  excludeIds: string[],
): Promise<ICourierProfile[]> {
  const staleCutoff = new Date(Date.now() - config.dispatch.stalenessMs);
  const filter: Record<string, unknown> = {
    onlineStatus: 'online',
    lastPingAt: { $gte: staleCutoff },
    eligibleJobTypes: job.type,
    maxWeightKg: { $gte: job.parcelSnapshot.weightKg },
    currentLocation: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: pickup },
        $maxDistance: radiusM,
      },
    },
  };
  if (excludeIds.length > 0) {
    filter.oxyUserId = { $nin: excludeIds };
  }

  const candidates = await CourierProfile.find(filter)
    .limit(config.dispatch.waveSize)
    .lean<ICourierProfile[]>();

  // Final precise capability gate (size class ordering is not a Mongo range).
  return candidates.filter((c) =>
    isEligible(
      {
        eligibleJobTypes: c.eligibleJobTypes,
        maxSizeClass: c.maxSizeClass,
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
  job: IJob,
  offerId: string,
  distanceM: number,
  expiresAt: Date,
): Promise<JobOfferView> {
  const rate = await getFairRate(OFFER_DISPLAY_CURRENCY);
  return {
    offerId,
    jobId: String(job._id),
    shipmentId: String(job.shipmentId),
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
  const job = await Job.findById(jobId);
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

  const excludeIds = await couriersWithLiveOffer(jobId);
  if (job.courierOxyUserId) {
    excludeIds.push(String(job.courierOxyUserId));
  }

  const candidates = await findCandidates(job, pickup, radiusM, excludeIds);

  // Always record that a wave was attempted (so the sweep can cap re-dispatch).
  job.dispatchAttempts = wave;
  await Job.updateOne({ _id: job._id }, { $set: { dispatchAttempts: wave } });

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
      await transition(job, 'offered', { note: 'dispatched to couriers' });
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
    const courierOxyUserId = String(candidate.oxyUserId);
    const courierCoords = candidate.currentLocation?.coordinates;
    const distanceM =
      courierCoords && courierCoords.length >= 2
        ? distanceMetersBetween(courierCoords, pickup)
        : radiusM;

    try {
      const created = await JobOffer.create({
        jobId: String(job._id),
        shipmentId: String(job.shipmentId),
        courierOxyUserId,
        ...(job.companyId ? { companyId: String(job.companyId) } : {}),
        status: 'offered' as const,
        offeredAt,
        expiresAt,
        rank,
        distanceM,
      });
      offered += 1;

      const view = await buildOfferView(job, String(created._id), distanceM, expiresAt);
      getIO()?.to(`user:${courierOxyUserId}`).emit(EVENTS.JOB_OFFER, view);
      await notifySafe({
        userId: courierOxyUserId,
        type: 'job_offered',
        title: 'New job offer',
        body: `A ${job.type} job near ${job.pickupSnapshot.address.city} is available.`,
        data: { jobId: String(job._id), offerId: String(created._id), expiresAt: expiresAt.toISOString() },
      });
    } catch (err) {
      log.general.warn({ err, jobId, courierOxyUserId }, 'Failed to create/emit a job offer (skipping candidate)');
    }
  }

  log.general.info({ jobId, wave, radiusM, offered }, 'Dispatched job offers');
  return { offered, wave };
}

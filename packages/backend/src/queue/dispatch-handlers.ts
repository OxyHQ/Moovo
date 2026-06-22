/**
 * Pure transport dispatch job handlers.
 *
 * These hold the ACTUAL work for the offer-expiry sweep + re-dispatch and a
 * one-off dispatch wave. Imported by BOTH `producers.ts` (run inline when Redis
 * is disabled) and `workers.ts` (the BullMQ processors), so queued and inline
 * behavior are identical. Kept in their own module (separate from the marketplace
 * `handlers.ts`) so the transport queue does not statically couple to the
 * marketplace order/review services.
 *
 * `handleExpireOffers` runs on a short cadence (`config.dispatch.expireOffersIntervalMs`):
 * 1. Flip every `offered` offer past its `expiresAt` to `expired` (semantic flip
 *    BEFORE the model's TTL backstop can reap it).
 * 2. For each job still awaiting a courier (`requested`/`offered`, non-terminal,
 *    with NO `accepted` offer): re-dispatch the next (wider) wave when
 *    `dispatchAttempts < config.dispatch.maxWaves`, otherwise cancel it
 *    (`no_courier`) and notify the sender.
 *
 * Best-effort throughout: a per-job failure is logged and the sweep continues.
 */

import { Job, type IJob } from '../models/job.js';
import { JobOffer } from '../models/job-offer.js';
import { sendNotification } from '../lib/notification-service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import type { DispatchWaveJob } from './types.js';

/** Statuses a job can be in while still awaiting a courier (re-dispatchable). */
const AWAITING_COURIER_STATUSES: readonly IJob['status'][] = ['requested', 'offered'];

/** Fire a notification, swallowing (and warning on) any failure. NEVER throws. */
async function notifySafe(options: Parameters<typeof sendNotification>[0]): Promise<void> {
  try {
    await sendNotification(options);
  } catch (err) {
    log.general.warn(
      { err, userId: options.userId, type: options.type },
      'Dispatch sweep notification failed (best-effort)',
    );
  }
}

/** Cancel a job that exhausted its dispatch waves with no taker + notify the sender. */
async function cancelNoCourier(job: IJob): Promise<void> {
  const { transition } = await import('../services/job.service.js');
  const doc = await Job.findById(job._id);
  if (!doc || doc.status === 'cancelled' || doc.status === 'delivered') {
    return;
  }
  await transition(doc, 'cancelled', { note: 'no_courier' });
  await JobOffer.updateMany({ jobId: String(job._id), status: 'offered' }, { $set: { status: 'superseded' } });
  await notifySafe({
    userId: String(job.senderOxyUserId),
    type: 'dispatch_no_courier',
    title: 'No courier available',
    body: 'We could not find a courier for your job. Please try again.',
    data: { jobId: String(job._id), jobNumber: job.jobNumber },
  });
  log.general.info({ jobId: String(job._id) }, 'Job cancelled — no courier found after max waves');
}

/**
 * The offer-expiry + re-dispatch sweep (repeatable). Expires stale offers, then
 * re-dispatches or cancels each job still awaiting a courier.
 */
export async function handleExpireOffers(): Promise<void> {
  const now = new Date();

  // 1. Flip stale live offers to `expired` (semantic, before the TTL backstop).
  const expired = await JobOffer.updateMany(
    { status: 'offered', expiresAt: { $lt: now } },
    { $set: { status: 'expired' } },
  );
  if (expired.modifiedCount > 0) {
    log.general.info({ count: expired.modifiedCount }, 'Expired stale job offers');
  }

  // 2. Find jobs still awaiting a courier with NO live offer (all expired/none).
  const awaiting = await Job.find({
    fulfillmentType: 'moovo_courier',
    status: { $in: [...AWAITING_COURIER_STATUSES] },
  }).lean<IJob[]>();
  if (awaiting.length === 0) {
    return;
  }

  const { dispatchJob } = await import('../services/dispatch.service.js');

  for (const job of awaiting) {
    try {
      const jobId = String(job._id);
      // Skip if this job still has a live offer (its window has not elapsed).
      const liveOffer = await JobOffer.exists({ jobId, status: 'offered' });
      if (liveOffer) {
        continue;
      }
      // An accepted offer means the job is being handled — skip (a status race).
      const acceptedOffer = await JobOffer.exists({ jobId, status: 'accepted' });
      if (acceptedOffer) {
        continue;
      }

      if (job.dispatchAttempts < config.dispatch.maxWaves) {
        await dispatchJob(jobId);
      } else {
        await cancelNoCourier(job);
      }
    } catch (err) {
      log.general.warn({ err, jobId: String(job._id) }, 'Offer sweep: per-job step failed (skipping)');
    }
  }
}

/** Dispatch (or re-dispatch) one job to a fresh wave (queued or inline). */
export async function handleDispatchWave(data: DispatchWaveJob): Promise<void> {
  const { dispatchJob } = await import('../services/dispatch.service.js');
  await dispatchJob(data.jobId);
}

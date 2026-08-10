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
 *    BEFORE the expiry sweep's unconditional delete can reap it — see
 *    `db/expiry.ts`, where `job_offers` is registered as a bounded-growth
 *    backstop precisely behind this flip).
 * 2. For each job still awaiting a courier (`requested`/`offered`, non-terminal,
 *    with NO `accepted` offer): re-dispatch the next (wider) wave when
 *    `dispatchAttempts < config.dispatch.maxWaves`, otherwise cancel it
 *    (`no_courier`) and notify the sender.
 *
 * Best-effort throughout: a per-job failure is logged and the sweep continues.
 */

import {
  findJobById,
  listJobsAwaitingCourier,
} from '../db/transport/jobRepository.js';
import type { JobRecord } from '../db/transport/jobShape.js';
import {
  expireLapsedOffers,
  jobHasOfferInStatus,
  supersedeLiveOffers,
} from '../db/transport/jobOfferRepository.js';
import { sendNotification } from '../lib/notification-service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import type { DispatchWaveJob } from './types.js';

/** Statuses a job can be in while still awaiting a courier (re-dispatchable). */
const AWAITING_COURIER_STATUSES: readonly JobRecord['status'][] = ['requested', 'offered'];

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
async function cancelNoCourier(job: JobRecord): Promise<void> {
  const { transition } = await import('../services/job.service.js');
  // Re-read: the sweep's candidate list was taken before the loop, so this job
  // may have been accepted, delivered or cancelled while earlier jobs were
  // being dispatched.
  const current = await findJobById(job.id);
  if (!current || current.status === 'cancelled' || current.status === 'delivered') {
    return;
  }
  await transition(current, 'cancelled', { note: 'no_courier' });
  await supersedeLiveOffers(job.id, undefined);
  await notifySafe({
    userId: job.senderOxyUserId,
    type: 'dispatch_no_courier',
    title: 'No courier available',
    body: 'We could not find a courier for your job. Please try again.',
    data: { jobId: job.id, jobNumber: job.jobNumber },
  });
  log.general.info({ jobId: job.id }, 'Job cancelled — no courier found after max waves');
}

/**
 * The offer-expiry + re-dispatch sweep (repeatable). Expires stale offers, then
 * re-dispatches or cancels each job still awaiting a courier.
 */
export async function handleExpireOffers(): Promise<void> {
  const now = new Date();

  // 1. Flip stale live offers to `expired` (semantic, before the expiry sweep's
  //    unconditional delete). The count comes off the affected-row count the
  //    server reported — an UPDATE with no RETURNING resolves to an EMPTY array
  //    whether it changed a thousand rows or none, so a `.length` here would
  //    report zero forever and read as a quiet sweep rather than a broken one.
  const expiredCount = await expireLapsedOffers(now);
  if (expiredCount > 0) {
    log.general.info({ count: expiredCount }, 'Expired stale job offers');
  }

  // 2. Find jobs still awaiting a courier with NO live offer (all expired/none).
  const awaiting = await listJobsAwaitingCourier(AWAITING_COURIER_STATUSES);
  if (awaiting.length === 0) {
    return;
  }

  const { dispatchJob } = await import('../services/dispatch.service.js');

  for (const job of awaiting) {
    try {
      // Both checks stay PER JOB rather than folded into the query above: the
      // loop dispatches as it goes, so by the time it reaches this job an
      // earlier iteration may have taken seconds, and a live or accepted offer
      // can have appeared in between. Asking once up front would answer about a
      // world that no longer exists.
      //
      // Skip if this job still has a live offer (its window has not elapsed).
      if (await jobHasOfferInStatus(job.id, 'offered')) {
        continue;
      }
      // An accepted offer means the job is being handled — skip (a status race).
      if (await jobHasOfferInStatus(job.id, 'accepted')) {
        continue;
      }

      if (job.dispatchAttempts < config.dispatch.maxWaves) {
        await dispatchJob(job.id);
      } else {
        await cancelNoCourier(job);
      }
    } catch (err) {
      log.general.warn({ err, jobId: job.id }, 'Offer sweep: per-job step failed (skipping)');
    }
  }
}

/** Dispatch (or re-dispatch) one job to a fresh wave (queued or inline). */
export async function handleDispatchWave(data: DispatchWaveJob): Promise<void> {
  const { dispatchJob } = await import('../services/dispatch.service.js');
  await dispatchJob(data.jobId);
}

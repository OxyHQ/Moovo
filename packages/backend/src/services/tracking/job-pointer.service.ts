/**
 * A Moovo delivery inside the tracker — as a POINTER, never a copy.
 *
 * Three designs were on the table and only one survives contact with the list
 * query:
 *
 * 1. **Union at read time** — query subscriptions, query jobs-where-I-am-the-
 *    sender, merge. Two cursors, mixed ordering, and every filter written
 *    twice. Rejected.
 * 2. **A tracked parcel per job, with `job_status_events` copied into
 *    `tracking_checkpoints`.** Duplicates the timeline and gives job history a
 *    SECOND writer. Rejected.
 * 3. **A pointer row.** Shipped.
 *
 * So a booked job gets one `tracked_parcels` row with `carrierKey = 'moovo'`,
 * `moovoJobId` set, `pollMode = 'manual'`, no due time, and **zero checkpoints
 * for its whole life** — plus one subscription for the sender. The list is then
 * one index scan over subscriptions: one cursor, one ordering, one filter set.
 * The DETAIL endpoint branches on `moovoJobId` and hydrates the job through
 * `job-hydration.service.ts` instead, so the live map, the courier card and
 * proof of delivery all keep working and `job_status_events` keeps exactly one
 * writer.
 *
 * One denormalised column, `tracked_parcels.status`, is mirrored from
 * `jobs.status` so the list can sort and filter without joining `jobs`. Its
 * single writer is `emitJobStatus`, which is already the one chokepoint every
 * job transition passes through. No trigger: this schema has none, and this is
 * not the feature to introduce the first one for.
 */

import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { requireTransaction } from '../../db/transactionGuard.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import { trackedParcels } from '../../db/schema/tracking.js';
import { trackedParcelExpiresAt } from '../../db/tracking/retention.js';
import { subscribeIfAbsent } from '../../db/tracking/trackedParcelSubscriptionRepository.js';
import { findParcelByJobId } from '../../db/tracking/trackedParcelRepository.js';
import { jobStatusToTrackingStatus } from './tracking-status.js';
import { log } from '../../lib/logger.js';
import type { JobStatus } from '@moovo/shared-types';

/** The carrier key the pointer rows live under. */
export const MOOVO_CARRIER_KEY = 'moovo';

/**
 * Create the pointer and subscribe the sender, inside the caller's transaction.
 *
 * `requireTransaction` rather than `DatabaseOrTransaction`, and the reason is
 * the one `db/transactionGuard.ts` documents: the union is satisfied by the
 * ROOT handle, so a caller who forgets to pass `tx` type-checks perfectly,
 * commits on its own connection outside the booking transaction, and leaves a
 * pointer to a job that rolled back.
 */
export async function createJobPointer(
  input: {
    jobId: string;
    jobNumber: string;
    senderOxyUserId: string;
    status: JobStatus;
  },
  db: DatabaseOrTransaction,
): Promise<void> {
  const tx = requireTransaction(db, 'createJobPointer');
  const now = new Date();

  const [parcel] = await tx
    .insert(trackedParcels)
    .values({
      id: uuidv7(),
      carrierKey: MOOVO_CARRIER_KEY,
      // The job number IS the tracking number, minus its separator: a sender
      // reading `MOV-000042` off a receipt can paste it and find their own
      // delivery. The CHECK refuses the hyphen, which is why it is stripped
      // through the same normalisation every other write uses.
      trackingNumber: input.jobNumber.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      status: jobStatusToTrackingStatus(input.status),
      moovoJobId: input.jobId,
      // Never fetched. There is nothing to fetch: the job's own timeline is the
      // truth, and this row exists only so the list has one shape.
      pollMode: 'manual',
      expiresAt: trackedParcelExpiresAt({ now, subscriberCount: 1, terminalAt: null }),
      subscriberCount: 1,
    })
    .onConflictDoNothing({
      target: [trackedParcels.carrierKey, trackedParcels.trackingNumber],
    })
    .returning();

  // A replayed booking converges on the prior job, so the pointer may already
  // exist. `DO NOTHING` plus this read is the same never-raise rule every
  // conflict in this domain follows.
  const row = parcel ?? (await findParcelByJobId(input.jobId, tx));
  if (!row) {
    log.general.warn(
      { jobId: input.jobId },
      '[Tracking] job pointer conflicted but no prior pointer was found',
    );
    return;
  }

  await subscribeIfAbsent(
    {
      parcelId: row.id,
      oxyUserId: input.senderOxyUserId,
      enteredNumber: input.jobNumber,
    },
    tx,
  );
}

/**
 * Keep the pointer's status in step with the job's.
 *
 * Best-effort and never throwing: a job transition is the authoritative event
 * and must not be undone because a denormalised mirror could not be written.
 * The row is only a sort key; the detail view reads the job itself.
 */
export async function mirrorJobStatus(jobId: string, status: JobStatus): Promise<void> {
  try {
    await getDb()
      .update(trackedParcels)
      .set({
        status: jobStatusToTrackingStatus(status),
        ...(status === 'delivered' ? { deliveredAt: new Date() } : {}),
      })
      .where(eq(trackedParcels.moovoJobId, jobId));
  } catch (error: unknown) {
    log.general.warn({ err: error, jobId }, '[Tracking] could not mirror job status onto pointer');
  }
}

/**
 * Job real-time events — the ONE place that emits a job's lifecycle transitions
 * over Socket.IO and fires the matching notification.
 *
 * Every status transition (accept/pickup/transit/deliver/scan/cancel) routes
 * through `emitJobStatus` so the socket event name, the notification type, and
 * the human copy live in a single mapping — no scattered emit strings, no copy
 * duplicated across call sites. Emits go to the SERVER-VERIFIED `user:<id>` rooms
 * only (`socket.ts`). Notifications are best-effort (`notifySafe`): a delivery
 * failure is logged and never aborts the transition that triggered it.
 *
 * The sender always receives the event; the assigned courier also receives it
 * for transitions they did not themselves drive (so both ends of a job stay in
 * sync). The `offered`/`requested` statuses are dispatch-internal and have no
 * sender-facing lifecycle event — offer fan-out is emitted by `dispatch.service`.
 */

import type { JobStatus } from '@moovo/shared-types';
import type { IJob } from '../models/job.js';
import type { NotificationType } from '../models/notification.js';
import { EVENTS, type JobSocketEvent } from '../lib/socket-events.js';
import { getIO } from '../socket.js';
import { sendNotification } from '../lib/notification-service.js';
import { log } from '../lib/logger.js';

/** A job status that has a sender-facing lifecycle event. */
type LifecycleStatus = Extract<
  JobStatus,
  'accepted' | 'picked_up' | 'in_transit' | 'delivered' | 'cancelled'
>;

/** Per-status socket event + notification type + human copy. */
interface StatusMeta {
  event: JobSocketEvent;
  type: NotificationType;
  title: string;
  body: string;
}

/** The single mapping of a lifecycle status to its event, type and copy. */
const STATUS_META: Record<LifecycleStatus, StatusMeta> = {
  accepted: {
    event: EVENTS.JOB_ACCEPTED,
    type: 'job_accepted',
    title: 'Courier assigned',
    body: 'A courier accepted your job and is on the way.',
  },
  picked_up: {
    event: EVENTS.JOB_PICKED_UP,
    type: 'job_picked_up',
    title: 'Picked up',
    body: 'Your shipment has been picked up.',
  },
  in_transit: {
    event: EVENTS.JOB_IN_TRANSIT,
    type: 'job_in_transit',
    title: 'On its way',
    body: 'Your shipment is in transit.',
  },
  delivered: {
    event: EVENTS.JOB_DELIVERED,
    type: 'job_delivered',
    title: 'Delivered',
    body: 'Your shipment has been delivered.',
  },
  cancelled: {
    event: EVENTS.JOB_CANCELLED,
    type: 'job_cancelled',
    title: 'Job cancelled',
    body: 'Your job has been cancelled.',
  },
};

/** Whether a status has a sender-facing lifecycle event. */
function isLifecycleStatus(status: JobStatus): status is LifecycleStatus {
  return status in STATUS_META;
}

/** Fire a notification, swallowing (and warning on) any failure. NEVER throws. */
async function notifySafe(options: Parameters<typeof sendNotification>[0]): Promise<void> {
  try {
    await sendNotification(options);
  } catch (err) {
    log.general.warn(
      { err, userId: options.userId, type: options.type },
      'Job notification delivery failed (best-effort)',
    );
  }
}

/**
 * Emit a job's lifecycle transition to the sender (and the assigned courier when
 * present) and notify the sender. Best-effort: a socket emit when no IO is
 * attached is a silent no-op, and a notification failure is logged not thrown.
 * No-op for non-lifecycle statuses (`requested`/`offered` are dispatch-internal).
 */
export async function emitJobStatus(job: IJob, status: JobStatus): Promise<void> {
  if (!isLifecycleStatus(status)) {
    return;
  }
  const meta = STATUS_META[status];
  const jobId = String(job._id);
  const senderId = String(job.senderOxyUserId);
  const payload = { jobId, status, jobNumber: job.jobNumber };

  const io = getIO();
  if (io) {
    io.to(`user:${senderId}`).emit(meta.event, payload);
    const courierId = job.courierOxyUserId ? String(job.courierOxyUserId) : undefined;
    if (courierId && courierId !== senderId) {
      io.to(`user:${courierId}`).emit(meta.event, payload);
    }
  }

  await notifySafe({
    userId: senderId,
    type: meta.type,
    title: meta.title,
    body: meta.body,
    data: { jobId, jobNumber: job.jobNumber, status },
  });
}

/**
 * Emit a live courier location ping to the sender during an active job. Silent
 * no-op when no IO is attached. Carries only the coordinates + timestamp.
 */
export function emitJobLocation(job: IJob, lng: number, lat: number): void {
  const io = getIO();
  if (!io) {
    return;
  }
  io.to(`user:${String(job.senderOxyUserId)}`).emit(EVENTS.JOB_LOCATION, {
    jobId: String(job._id),
    location: { type: 'Point' as const, coordinates: [lng, lat] },
    at: new Date().toISOString(),
  });
}

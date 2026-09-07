/**
 * Telling people their parcel moved.
 *
 * One `TRACKING_STATUS_META` map, structurally identical to the single
 * `STATUS_META` in `job-events.service.ts`: status to socket event, to
 * notification type, to copy. A status with no entry is SILENT by construction
 * rather than by an `if` somebody has to remember.
 *
 * ## Only some statuses are worth a push, and that is a product decision
 *
 * `pending`, `info_received` and `in_transit` are deliberately absent. A parcel
 * moving between depots is not news, and pushing on every checkpoint is the
 * fastest way to have a tracker's notification permission revoked — after which
 * the one push that mattered never arrives either.
 *
 * ## Anonymous devices receive nothing, by construction
 *
 * `socket.ts` authenticates every connection and joins only the server-verified
 * `user:<oxyUserId>` room; clients cannot name a room. So a signed-out lookup
 * has no address, and `notifications.oxy_user_id` is NOT NULL so there is no
 * row to write either. That is the tracker's design — without an account there
 * is nobody to tell — and the fix for "anonymous users don't get live updates"
 * is signing in, never a client-named `device:` room.
 */

import { getIO } from '../../socket.js';
import { EVENTS } from '../../lib/socket-events.js';
import { log } from '../../lib/logger.js';
import { sendNotification } from '../../lib/notification-service.js';
import {
  listSubscribersOfParcel,
  markNotified,
} from '../../db/tracking/trackedParcelSubscriptionRepository.js';
import type { TrackedParcelRow } from '../../db/tracking/trackedParcelRepository.js';
import type { PollOutcome } from './tracking-poll.service.js';
import type { TrackingStatus } from '@moovo/shared-types';
import type { NOTIFICATION_TYPES } from '../../db/schema/valueSets.js';

interface StatusMeta {
  notification: (typeof NOTIFICATION_TYPES)[number];
  title: string;
  body: (parcel: { trackingNumber: string; carrierKey: string }) => string;
}

/**
 * The statuses worth interrupting somebody for.
 *
 * Compared as an EXACT SET by its test, for the reason `DELIVERY_FACT_KEYS` is:
 * a list of "must not notify on X" assertions only fails when a named status
 * DISAPPEARS, and is silent about one somebody ADDS — which is exactly how a
 * notification-spam regression arrives.
 */
export const TRACKING_STATUS_META: Readonly<Partial<Record<TrackingStatus, StatusMeta>>> =
  Object.freeze({
    out_for_delivery: {
      notification: 'tracking_out_for_delivery',
      title: 'Out for delivery',
      body: (parcel) => `${parcel.trackingNumber} is out for delivery today.`,
    },
    delivered: {
      notification: 'tracking_delivered',
      title: 'Delivered',
      body: (parcel) => `${parcel.trackingNumber} has been delivered.`,
    },
    available_for_pickup: {
      notification: 'tracking_available_for_pickup',
      title: 'Ready for collection',
      body: (parcel) => `${parcel.trackingNumber} is waiting to be collected.`,
    },
    failed_attempt: {
      notification: 'tracking_exception',
      title: 'Delivery attempt failed',
      body: (parcel) => `Nobody was in for ${parcel.trackingNumber}. The carrier will retry.`,
    },
    exception: {
      notification: 'tracking_exception',
      title: 'There is a problem with your parcel',
      body: (parcel) => `${parcel.trackingNumber} needs attention.`,
    },
    returned: {
      notification: 'tracking_exception',
      title: 'Returned to sender',
      body: (parcel) => `${parcel.trackingNumber} is on its way back to the sender.`,
    },
  });

/** Never throws. A notification failure must not undo a poll that committed. */
async function notifySafe(options: Parameters<typeof sendNotification>[0]): Promise<void> {
  try {
    await sendNotification(options);
  } catch (error: unknown) {
    log.general.warn({ err: error, type: options.type }, '[Tracking] notification failed');
  }
}

/**
 * Tell everyone watching this parcel what changed.
 *
 * Push only on a status TRANSITION that `TRACKING_STATUS_META` names; new
 * checkpoints without a transition get a socket event and nothing else, so an
 * open app updates live while a closed one stays quiet.
 */
export async function announceParcelChange(
  parcel: TrackedParcelRow,
  outcome: PollOutcome,
): Promise<void> {
  const statusChanged = outcome.status !== outcome.previousStatus;
  const meta = statusChanged ? TRACKING_STATUS_META[outcome.status] : undefined;

  let subscribers: Awaited<ReturnType<typeof listSubscribersOfParcel>>;
  try {
    subscribers = await listSubscribersOfParcel(parcel.id);
  } catch (error: unknown) {
    log.general.warn({ err: error, parcelId: parcel.id }, '[Tracking] subscriber fan-out failed');
    return;
  }

  const io = getIO();
  const payload = {
    parcelId: parcel.id,
    carrierKey: parcel.carrierKey,
    trackingNumber: parcel.trackingNumber,
    status: outcome.status,
    previousStatus: outcome.previousStatus,
    newCheckpoints: outcome.newCheckpointIds.length,
  };

  for (const subscription of subscribers) {
    // The socket event carries the subscription's own id, because that is the
    // id the client holds — `tracked_parcels.id` is shared and never leaves the
    // server.
    io?.to(`user:${subscription.oxyUserId}`).emit(
      statusChanged ? EVENTS.TRACKING_STATUS : EVENTS.TRACKING_UPDATED,
      { ...payload, id: subscription.id },
    );

    if (!meta || !subscription.notifyOnStateChange) continue;

    // Per SUBSCRIPTION, not per parcel: somebody who added this parcel after it
    // was already out for delivery must not be pushed that event retroactively.
    if (
      outcome.latestCheckpointAt &&
      subscription.lastNotifiedCheckpointAt &&
      outcome.latestCheckpointAt <= subscription.lastNotifiedCheckpointAt
    ) {
      continue;
    }

    await notifySafe({
      userId: subscription.oxyUserId,
      type: meta.notification,
      title: meta.title,
      body: meta.body(parcel),
      data: { parcelId: subscription.id, trackingNumber: parcel.trackingNumber },
    });

    if (outcome.latestCheckpointAt) {
      try {
        await markNotified(subscription.id, outcome.latestCheckpointAt);
      } catch (error: unknown) {
        log.general.warn(
          { err: error, subscriptionId: subscription.id },
          '[Tracking] could not record notification watermark',
        );
      }
    }
  }
}

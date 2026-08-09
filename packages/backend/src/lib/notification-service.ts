/**
 * Notification Service
 *
 * Delivers notifications to users via multiple channels:
 * - in_app: Socket.io real-time event
 * - push: Expo push notifications (mobile)
 * - telegram/discord/whatsapp/slack: via channel outbound system
 *
 * Each notification is persisted and can be delivered to multiple channels simultaneously.
 */

import Expo, { type ExpoPushMessage, type ExpoPushReceiptId } from 'expo-server-sdk';
import { WebPushError } from 'web-push';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
} from '../db/schema/valueSets.js';
import {
  countUnreadForUser,
  dismissNotificationById,
  insertNotification,
  markAllNotificationsRead,
  markNotificationRead,
  updateDeliveryStatus,
  type DeliveryStatus,
  type NotificationRow,
} from '../db/notifications/notificationRepository.js';
import {
  deactivatePushTokenById,
  deactivatePushTokenByValue,
  hasActivePushToken,
  hasActiveWebPushSubscription,
  listActivePushTokens,
  listActiveWebPushSubscriptions,
  deactivateWebPushSubscriptionById,
  touchPushTokens,
} from '../db/notifications/pushRepository.js';
import { webPush, VAPID_PUBLIC_KEY } from './web-push.js';
import { getIO } from '../socket.js';
import { log } from './logger.js';

// ── Expo push singleton ──────────────────────────────────────────────
const expo = new Expo();

/**
 * Push-endpoint HTTP statuses that mean a web-push subscription is permanently
 * dead (expired or unknown) and should be deactivated rather than retried.
 */
const HTTP_GONE = 410;
const HTTP_NOT_FOUND = 404;

// ── Types ──────────────────────────────────────────────────────────

/**
 * The notification vocabularies, derived from the schema's own tuples.
 *
 * They lived on the deleted Mongoose model, which also declared them as its
 * `enum`. The same tuples now render the table's CHECK constraints, so
 * deriving here keeps the TypeScript union, the column and the constraint
 * moving together instead of leaving a second copy to drift.
 */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export interface SendNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  data?: Record<string, any>;
  triggerId?: string;
  conversationId?: string;
  expiresAt?: Date;
}

// ── Resolve delivery channels ──────────────────────────────────────

/**
 * Determine which channels to deliver a notification to.
 * If explicit channels are provided, use those. Otherwise, default to in_app
 * plus any connected messaging accounts the user has.
 */
async function resolveChannels(userId: string, explicit?: NotificationChannel[]): Promise<NotificationChannel[]> {
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // Default: always in_app
  const channels: NotificationChannel[] = ['in_app'];

  // Check in parallel: push tokens and web push subscriptions
  const [hasPushTokens, hasWebPushSubs] = await Promise.all([
    // Push: check if user has any active Expo push tokens
    hasActivePushToken(userId).catch(() => false),

    // Web push: check if user has any active browser push subscriptions (only if VAPID configured)
    VAPID_PUBLIC_KEY ? hasActiveWebPushSubscription(userId).catch(() => false) : false,
  ]);

  if (hasPushTokens || hasWebPushSubs) {
    channels.push('push');
  }

  return channels;
}

/**
 * A notification's free-form `data`, as a spreadable object.
 *
 * The column is `jsonb`, which drizzle types `unknown` — correct, since the
 * database will hand back whatever was stored, including a bare string or
 * number if some future writer puts one there. Both push payloads spread it,
 * and spreading a non-object silently contributes nothing rather than
 * throwing, so this narrows once instead of casting at each call site.
 */
function payloadData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

// ── Channel delivery implementations ───────────────────────────────

async function deliverInApp(notification: NotificationRow): Promise<boolean> {
  const io = getIO();
  if (!io) return false;

  io.to(`user:${notification.oxyUserId}`).emit('notification', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority,
    data: notification.data,
    createdAt: notification.createdAt,
  });

  return true;
}

// ── Expo Push Notifications ─────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered Expo push tokens.
 * Handles chunked sending (Expo limit) and async receipt checking.
 */
async function deliverPush(userId: string, notification: NotificationRow): Promise<boolean> {
  const tokens = await listActivePushTokens(userId);

  if (tokens.length === 0) return false;

  // Build messages — one per device token
  const messages: ExpoPushMessage[] = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) {
      log.general.warn({ token: t.token, userId }, 'Invalid Expo push token, deactivating');
      await deactivatePushTokenById(t.id);
      continue;
    }

    messages.push({
      to: t.token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        conversationId: notification.conversationId,
        ...payloadData(notification.data),
      },
      sound: 'default',
      priority: notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
      channelId: 'default',
    });
  }

  if (messages.length === 0) return false;

  // Send in chunks (Expo recommends batches of ~100)
  const chunks = expo.chunkPushNotifications(messages);
  const receiptIds: ExpoPushReceiptId[] = [];
  let anySucceeded = false;

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
          anySucceeded = true;
          if (ticket.id) {
            receiptIds.push(ticket.id);
          }
        } else {
          // ticket.status === 'error' — `chunk[i]` is the matching ExpoPushMessage.
          // Each message was built with a single-token `to`, so normalize the
          // `ExpoPushToken | ExpoPushToken[]` union back to one token string.
          const messageTo = chunk[i]?.to;
          const failedToken = Array.isArray(messageTo) ? messageTo[0] : messageTo;
          log.general.warn(
            { userId, token: failedToken, error: ticket.message, errorCode: ticket.details?.error },
            'Expo push ticket error',
          );

          // Deactivate tokens that are permanently invalid
          if (ticket.details?.error === 'DeviceNotRegistered' && failedToken) {
            await deactivatePushTokenByValue(failedToken);
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error, userId }, 'Expo push chunk send failed');
    }
  }

  // Fire-and-forget receipt checking (delayed)
  if (receiptIds.length > 0) {
    setTimeout(() => checkPushReceipts(receiptIds).catch(() => {}), 15_000);
  }

  // Update lastUsedAt for active tokens
  if (anySucceeded) {
    await touchPushTokens(tokens.filter(t => Expo.isExpoPushToken(t.token)).map(t => t.id));
  }

  return anySucceeded;
}

/**
 * Check push notification receipts after a delay.
 * Expo recommends checking ~15 seconds after sending.
 * Deactivates tokens that received DeviceNotRegistered errors.
 */
async function checkPushReceipts(receiptIds: ExpoPushReceiptId[]): Promise<void> {
  const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of chunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          const { message, details } = receipt;
          log.general.warn({ receiptId, message, error: details?.error }, 'Expo push receipt error');

          // Deactivate invalid device tokens
          if (details?.error === 'DeviceNotRegistered') {
            // We can't directly map receiptId -> token, but Expo will stop delivering
            // to unregistered devices. The token gets deactivated on the next send attempt.
            log.general.info({ receiptId }, 'Device not registered — token will be deactivated on next send');
          }
        }
      }
    } catch (error) {
      log.general.error({ err: error }, 'Failed to check Expo push receipts');
    }
  }
}

// ── Web Push Notifications ───────────────────────────────────────────

/**
 * Deliver a push notification to all of a user's registered web push subscriptions.
 * Handles 410 Gone (expired subscription) by deactivating.
 */
async function deliverWebPush(userId: string, notification: NotificationRow): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;

  const subscriptions = await listActiveWebPushSubscriptions(userId);

  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    notificationId: notification.id,
    type: notification.type,
    conversationId: notification.conversationId,
    ...payloadData(notification.data),
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        // `keys` is two flat columns in Postgres; web-push wants the nested
        // pair back, so it is reassembled at the boundary rather than stored
        // as a jsonb blob nothing else reads.
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keyP256dh, auth: sub.keyAuth } },
          payload,
        );
      } catch (error: unknown) {
        const isGone =
          error instanceof WebPushError &&
          (error.statusCode === HTTP_GONE || error.statusCode === HTTP_NOT_FOUND);
        if (isGone) {
          // Subscription expired or invalid — deactivate
          await deactivateWebPushSubscriptionById(sub.id);
          log.general.info({ userId, endpoint: sub.endpoint }, 'Web push subscription expired, deactivated');
        } else {
          log.general.warn({ err: error, userId, endpoint: sub.endpoint }, 'Web push delivery failed');
        }
        throw error; // Re-throw so Promise.allSettled marks as rejected
      }
    }),
  );

  return results.some(r => r.status === 'fulfilled');
}

// ── Main send function ─────────────────────────────────────────────

/**
 * Create and deliver a notification to a user across their preferred channels.
 */
export async function sendNotification(options: SendNotificationOptions): Promise<NotificationRow> {
  const {
    userId,
    type,
    title,
    body,
    priority = 'normal',
    data,
    triggerId,
    conversationId,
    expiresAt,
  } = options;

  const channels = await resolveChannels(userId, options.channels);

  // Persist the notification
  const deliveryStatus: DeliveryStatus = Object.fromEntries(
    channels.map((ch) => [ch, 'pending']),
  );
  const notification = await insertNotification({
    oxyUserId: userId,
    type,
    title,
    body: body.slice(0, 4000), // Cap body length
    data,
    channels,
    deliveryStatus,
    status: 'sent',
    priority,
    // Plain text now. The source wrapped this in `new ObjectId(...)`, which
    // THREW on a non-ObjectId string; the column is text with no foreign key
    // (there is no `Trigger` table anywhere in this codebase to reference), so
    // the value is stored as given.
    triggerId,
    conversationId,
    expiresAt,
  });

  // Deliver to each channel in parallel
  const deliveries = channels.map(async (channel) => {
    try {
      let success = false;

      switch (channel) {
        case 'in_app':
          success = await deliverInApp(notification);
          break;
        case 'push': {
          // Deliver to both Expo (mobile) and web push in parallel
          const [expoPushOk, webPushOk] = await Promise.all([
            deliverPush(userId, notification),
            deliverWebPush(userId, notification),
          ]);
          success = expoPushOk || webPushOk;
          break;
        }
      }

      deliveryStatus[channel] = success ? 'sent' : 'failed';
    } catch (error: unknown) {
      log.general.error({ err: error, channel, userId }, 'Notification delivery failed');
      deliveryStatus[channel] = 'failed';
    }
  });

  await Promise.allSettled(deliveries);

  // Persist delivery status. The source mutated the loaded document and called
  // `.save()`, which rewrote every field; this writes only the column that
  // changed, so a concurrent read/dismiss of the same row is not clobbered by
  // a stale copy of the rest of it.
  await updateDeliveryStatus(notification.id, deliveryStatus);

  log.general.info(
    { type, userId, channels, title: title.slice(0, 50) },
    'Notification sent',
  );

  return notification;
}

// ── Query helpers ──────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return await countUnreadForUser(userId);
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  return await markNotificationRead(notificationId, userId);
}

export async function markAllAsRead(userId: string): Promise<number> {
  return await markAllNotificationsRead(userId);
}

export async function dismissNotification(notificationId: string, userId: string): Promise<boolean> {
  return await dismissNotificationById(notificationId, userId);
}

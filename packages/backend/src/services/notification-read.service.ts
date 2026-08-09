/**
 * Notification read/management service.
 *
 * This is the READ + management side of notifications (listing, unread count,
 * read/dismiss state, and push-token / web-push-subscription registration). The
 * DELIVERY side (creating + fanning a notification out across channels) lives in
 * `lib/notification-service.ts`; the read-state mutations here delegate to that
 * module's `getUnreadCount` / `markAsRead` / `markAllAsRead` / `dismissNotification`
 * helpers so there is one source of truth for those transitions.
 *
 * All operations are scoped to `oxyUserId`. Logic lives here; the controller is
 * thin.
 */

import Expo from 'expo-server-sdk';
import {
  countNotificationsForUser,
  listNotificationsForUser,
  type NotificationRow,
} from '../db/notifications/notificationRepository.js';
import {
  deactivatePushTokenForUser,
  deactivateWebPushSubscriptionForUser,
  upsertPushToken,
  upsertWebPushSubscription,
} from '../db/notifications/pushRepository.js';
import {
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  dismissNotification,
  type NotificationPriority,
  type NotificationStatus,
  type NotificationType,
} from '../lib/notification-service.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';

/** A single notification as returned on the wire. */
export interface NotificationDTO {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: NotificationStatus;
  priority: NotificationPriority;
  conversationId?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Serialize a stored row to the wire `NotificationDTO`.
 *
 * `!== null`, not `!== undefined`: Mongo OMITTED an unset optional field while
 * Postgres returns `null`, and the old test passes for `null` — so a straight
 * translation would start emitting `{"data": null, "conversationId": null,
 * "readAt": null}` on every notification that has none of them. Nothing fails;
 * clients simply begin receiving three fields that never existed.
 */
function toDTO(row: NotificationRow): NotificationDTO {
  const dto: NotificationDTO = {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    status: row.status as NotificationStatus,
    priority: row.priority as NotificationPriority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.data !== null) dto.data = row.data as Record<string, unknown>;
  if (row.conversationId !== null) dto.conversationId = row.conversationId;
  if (row.readAt !== null) dto.readAt = row.readAt.toISOString();
  return dto;
}

/**
 * List the user's notifications (newest first, offset-paginated) together with
 * the matched `total` and the live `unreadCount`. Optional `status`/`type`
 * filters narrow the list (and the total).
 */
export async function listNotifications(
  oxyUserId: string,
  opts: { page: number; limit: number; status?: string; type?: string },
): Promise<{ data: NotificationDTO[]; total: number; unreadCount: number }> {
  const { page, limit, status, type } = opts;
  // ONE filter object feeding both the page and its total — two spellings can
  // disagree, and the symptom is a paginator whose count never matches its rows.
  const filter = { status: status || undefined, type: type || undefined };

  const [rows, total, unreadCount] = await Promise.all([
    listNotificationsForUser(oxyUserId, filter, { limit, offset: (page - 1) * limit }),
    countNotificationsForUser(oxyUserId, filter),
    getUnreadCount(oxyUserId),
  ]);

  return { data: rows.map(toDTO), total, unreadCount };
}

/** The user's live unread-notification count. */
export async function getUnread(oxyUserId: string): Promise<number> {
  return getUnreadCount(oxyUserId);
}

/** Mark a single notification read, or throw NOT_FOUND if it is not the user's. */
export async function markRead(oxyUserId: string, notificationId: string): Promise<void> {
  const ok = await markAsRead(notificationId, oxyUserId);
  if (!ok) {
    throw notFound('Notification not found');
  }
}

/** Mark all of the user's unread notifications read; returns the affected count. */
export async function markAllRead(oxyUserId: string): Promise<number> {
  return markAllAsRead(oxyUserId);
}

/** Dismiss a single notification, or throw NOT_FOUND if it is not the user's. */
export async function dismiss(oxyUserId: string, notificationId: string): Promise<void> {
  const ok = await dismissNotification(notificationId, oxyUserId);
  if (!ok) {
    throw notFound('Notification not found');
  }
}

/**
 * Register (or reactivate) an Expo push token for the user. The token format is
 * validated as a domain rule; an upsert keyed on `(oxyUserId, token)` reactivates
 * an already-known token rather than duplicating it.
 */
export async function registerPushToken(
  oxyUserId: string,
  input: { token: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' },
): Promise<{ id: string }> {
  if (!Expo.isExpoPushToken(input.token)) {
    throw validationError('Invalid Expo push token format');
  }

  const pushToken = await upsertPushToken({
    oxyUserId,
    token: input.token,
    deviceId: input.deviceId,
    platform: input.platform,
  });

  return { id: pushToken.id };
}

/** Deactivate an Expo push token (logout / uninstall), or throw NOT_FOUND. */
export async function removePushToken(oxyUserId: string, token: string): Promise<void> {
  // `matchedCount` semantics: deactivating an ALREADY-inactive token succeeds,
  // exactly as it does today. A repeated logout must not 404.
  const existed = await deactivatePushTokenForUser(oxyUserId, token);
  if (!existed) {
    throw notFound('Push token not found');
  }
}

/**
 * Register (or reactivate) a browser web-push subscription for the user. Upsert
 * keyed on `(oxyUserId, endpoint)` refreshes the stored keys for a known endpoint.
 */
export async function registerWebPushSubscription(
  oxyUserId: string,
  input: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<{ id: string }> {
  const subscription = await upsertWebPushSubscription({
    oxyUserId,
    endpoint: input.endpoint,
    keyP256dh: input.keys.p256dh,
    keyAuth: input.keys.auth,
  });

  return { id: subscription.id };
}

/** Deactivate a browser web-push subscription, or throw NOT_FOUND. */
export async function removeWebPushSubscription(
  oxyUserId: string,
  endpoint: string,
): Promise<void> {
  const existed = await deactivateWebPushSubscriptionForUser(oxyUserId, endpoint);
  if (!existed) {
    throw notFound('Subscription not found');
  }
}

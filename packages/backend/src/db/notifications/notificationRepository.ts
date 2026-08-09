/**
 * Every statement this service issues against `notifications`.
 *
 * ## The one thing to get right here: `modifiedCount` is not `matchedCount`
 *
 * Mongo reports both, and this domain's callers deliberately use DIFFERENT
 * ones. Postgres reports only `rowCount`, which behaves like `matchedCount` —
 * an UPDATE that writes a column its existing value still counts the row. So
 * every `modifiedCount` caller needs its "would this actually change anything"
 * condition MOVED INTO the WHERE clause, and every `matchedCount` caller must
 * NOT get one. Both mistakes are silent, and they fail in opposite directions:
 *
 *  - `dismissNotification` returns `modifiedCount > 0`, and its update sets
 *    `status: 'dismissed'` and nothing else. So dismissing an ALREADY-dismissed
 *    notification reports false today, and the service turns that into a 404.
 *    Reproduced faithfully by `status <> 'dismissed'` in the predicate. Drop it
 *    and a second dismiss starts returning 204 — a behaviour change nothing
 *    would flag.
 *  - `markAsRead` and `markAllAsRead` also read `modifiedCount`, but they set
 *    `readAt` to a fresh `Date` on every call, so a matched row ALWAYS changes
 *    and the two counts coincide. They need no extra predicate, and adding one
 *    (`status <> 'read'`) would break re-reading a notification.
 *
 * The `push_tokens` / `web_push_subscriptions` deactivations read
 * `matchedCount`, so they are plain `rowCount` — see `pushRepository`.
 */

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { notifications } from '../schema/notifications';

/** A `notifications` row exactly as stored. */
export type NotificationRow = typeof notifications.$inferSelect;

/** The per-channel delivery map, `{channel: 'pending'|'sent'|'failed'}`. */
export type DeliveryStatus = Record<string, string>;

/** What `insertNotification` needs. */
export interface NewNotification {
  oxyUserId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | undefined;
  channels: string[];
  deliveryStatus: DeliveryStatus;
  status: string;
  priority: string;
  triggerId?: string | undefined;
  conversationId?: string | undefined;
  expiresAt?: Date | undefined;
}

/** Narrowing filters for the list and its total — both must use the SAME set. */
export interface NotificationFilter {
  status?: string | undefined;
  type?: string | undefined;
}

/**
 * The list/count predicate, built ONCE.
 *
 * `listNotifications` returns rows and a `total` that must describe the same
 * query; two spellings of one filter can disagree, and the symptom is a
 * paginator whose last page is empty or whose count never reaches the rows.
 */
function matching(oxyUserId: string, filter: NotificationFilter) {
  const clauses = [eq(notifications.oxyUserId, oxyUserId)];
  if (filter.status !== undefined) clauses.push(eq(notifications.status, filter.status));
  if (filter.type !== undefined) clauses.push(eq(notifications.type, filter.type));
  return and(...clauses);
}

/** Statuses that count as unread — the source's `{$in: ['pending', 'sent']}`. */
const UNREAD_STATUSES = ['pending', 'sent'] as const;

/** Store one notification and return it. */
export async function insertNotification(
  input: NewNotification,
  db: DatabaseOrTransaction = getDb(),
): Promise<NotificationRow> {
  const [row] = await db
    .insert(notifications)
    .values({
      id: uuidv7(),
      oxyUserId: input.oxyUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      channels: input.channels,
      deliveryStatus: input.deliveryStatus,
      status: input.status,
      priority: input.priority,
      triggerId: input.triggerId ?? null,
      conversationId: input.conversationId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (row === undefined) {
    throw new Error('Inserting a notification returned no row.');
  }
  return row;
}

/**
 * Persist the per-channel delivery outcomes after the fan-out.
 *
 * A separate statement because the source mutates the loaded document and
 * calls `.save()`; there is no document to mutate here, and writing the whole
 * row back would race the fan-out's own concurrent updates for other channels.
 */
export async function updateDeliveryStatus(
  notificationId: string,
  deliveryStatus: DeliveryStatus,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(notifications)
    .set({ deliveryStatus })
    .where(eq(notifications.id, notificationId));
}

/** One page of the user's notifications, newest first. */
export async function listNotificationsForUser(
  oxyUserId: string,
  filter: NotificationFilter,
  page: { limit: number; offset: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<NotificationRow[]> {
  return await db
    .select()
    .from(notifications)
    .where(matching(oxyUserId, filter))
    // `id` breaks ties, for the reason spelled out in `feedbackRepository`:
    // offset pagination over a non-unique sort can serve a row twice and skip
    // another. uuid v7 is time-ordered, so it agrees with `createdAt`.
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(page.limit)
    .offset(page.offset);
}

/** How many match, for the pagination envelope. `count()` maps with `Number`. */
export async function countNotificationsForUser(
  oxyUserId: string,
  filter: NotificationFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(matching(oxyUserId, filter));
  return row?.total ?? 0;
}

/** The user's live unread count — `pending` or `sent`. */
export async function countUnreadForUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...UNREAD_STATUSES]),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Mark one notification read. Returns whether it was the user's.
 *
 * No `status <> 'read'` predicate, deliberately: the source sets a fresh
 * `readAt` on every call, so a matched row always changed and its
 * `modifiedCount` equalled its `matchedCount`. Adding one here would make
 * re-reading an already-read notification 404.
 */
export async function markNotificationRead(
  notificationId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.oxyUserId, oxyUserId)));
  return (result.count ?? 0) > 0;
}

/** Mark every unread notification read; returns how many moved. */
export async function markAllNotificationsRead(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...UNREAD_STATUSES]),
      ),
    );
  return result.count ?? 0;
}

/**
 * Dismiss one notification. Returns whether anything moved.
 *
 * `status <> 'dismissed'` is what reproduces the source's `modifiedCount`:
 * its update sets only `status`, so a second dismiss changed nothing and
 * reported false, which the service turns into a 404. Without the predicate a
 * repeat dismiss would start succeeding — a change no test would notice.
 *
 * It also keeps `dismissed_since` honest, since that generated column is
 * `created_at` for a dismissed row: re-dismissing must not look like a fresh
 * dismissal to the expiry sweep.
 */
export async function dismissNotificationById(
  notificationId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ status: 'dismissed' })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.oxyUserId, oxyUserId),
        sql`${notifications.status} <> 'dismissed'`,
      ),
    );
  return (result.count ?? 0) > 0;
}

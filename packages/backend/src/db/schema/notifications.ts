/**
 * User-facing notifications.
 *
 * This table owns the subtlest piece of the whole port, so it lives in its own
 * file: the TTL index it replaces is PARTIAL, and a sweep that loses that
 * partiality deletes every notification older than ninety days instead of only
 * the dismissed ones. That is data loss wearing housekeeping clothes — no
 * error, no failing test, and a symptom that appears months later as "my
 * notification history is empty".
 */

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { closedSet, closedSetArray, foreignServiceId } from './columns';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
} from './valueSets';

/**
 * How long a DISMISSED notification is kept. Ported from the source's
 * `expireAfterSeconds: 90 * 24 * 60 * 60`.
 */
export const NOTIFICATION_DISMISSED_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export const notifications = pgTable(
  'notifications',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    data: jsonb(),
    channels: text().array().notNull().default(sql`'{}'::text[]`),
    /** `{channel: 'pending'|'sent'|'failed'}` — an open map, so jsonb. */
    deliveryStatus: jsonb().notNull().default(sql`'{}'::jsonb`),
    status: text().notNull().default('pending'),
    priority: text().notNull().default('normal'),
    /**
     * The source declares this `{type: ObjectId, ref: 'Trigger'}` — the ONLY
     * mongoose `ref` in the entire model set, pointing at a `Trigger`
     * collection that does not exist anywhere in this codebase.
     *
     * It is kept because `notification-service.ts` really does write it, but
     * it is plain text with NO foreign key: there is no table to reference,
     * and inventing one to satisfy a dangling ref would be modelling a
     * relationship that does not exist.
     */
    triggerId: text(),
    conversationId: text(),
    /**
     * Present in the source, and DELIBERATELY NOT the expiry deadline.
     *
     * It is unindexed there and no TTL index keys off it; the actual TTL keys
     * off `createdAt`. Wiring this up as a deadline because the name suggests
     * one would start reaping rows nothing ever reaped.
     *
     * It is also written through by `sendNotification` but passed by none of
     * its call sites, which makes it a candidate for removal — deliberately
     * NOT taken here. "No caller passes it" and "no stored document has it"
     * are different claims, and only the second licenses a drop; a census of
     * the live collection is what settles it, and the drop is then a `post`
     * migration rather than a guess baked into the foundation.
     */
    expiresAt: timestamptz(),
    readAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The expiry deadline, and the reason the partial filter cannot be lost.
     *
     * The Mongo index is `{createdAt: 1}` with `expireAfterSeconds` of ninety
     * days AND `partialFilterExpression: {status: 'dismissed'}` — so only a
     * DISMISSED notification is ever reaped, and a merely-old one that is
     * still `pending`, `sent` or `read` is kept forever. (The source's comment
     * says "dismissed/expired", which is wrong; the index is what runs.)
     *
     * `@oxyhq/db`'s `ExpirySweepTarget` is `{table, column, retentionSeconds}`
     * — it has NO predicate field, so the partial filter has nowhere to live
     * as a sweep argument. Rather than fork the sweep or hand-roll a second
     * one, the filter is folded into the COLUMN: this is `created_at` for a
     * dismissed row and NULL for every other row, and `NULL <= now() - 90d` is
     * never true.
     *
     * That makes the partiality structural. A registry entry pointing here
     * cannot "forget" the predicate, because the predicate is the column's
     * definition — there is no argument anyone could omit. It also tracks
     * status changes for free: un-dismissing a notification returns the column
     * to NULL and takes the row back out of the sweep's reach.
     */
    dismissedSince: timestamptz().generatedAlwaysAs(
      sql`case when status = 'dismissed' then created_at end`,
    ),
  },
  (table) => [
    closedSet('notifications_type_check', table.type, NOTIFICATION_TYPES),
    closedSet('notifications_status_check', table.status, NOTIFICATION_STATUSES),
    closedSet('notifications_priority_check', table.priority, NOTIFICATION_PRIORITIES),
    closedSetArray('notifications_channels_check', table.channels, NOTIFICATION_CHANNELS),
    index('notifications_user_status_created_idx').on(
      table.oxyUserId,
      table.status,
      table.createdAt,
    ),
    /**
     * The unread feed and unread count. A PARTIAL index, exactly as the source
     * declares `partialFilterExpression: {status: {$in: ['pending','sent']}}`.
     */
    index('notifications_user_unread_idx')
      .on(table.oxyUserId, table.createdAt)
      .where(sql`${table.status} in ('pending', 'sent')`),
    /**
     * The sweep's supporting index. It must be a LEADING btree on the swept
     * column or the sweep is a full table scan every run — `@oxyhq/db`'s
     * expiry-coverage gate fails the build if it disappears.
     */
    index('notifications_dismissed_since_idx').on(table.dismissedSince),
  ],
);

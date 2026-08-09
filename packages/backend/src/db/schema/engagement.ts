/**
 * Engagement: reviews, in-app feedback, and the two push-delivery registries.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, generatedId, updatedAt } from '@oxyhq/db';
import { closedSet, foreignServiceId } from './columns';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  PUSH_PLATFORMS,
  REVIEW_STATUSES,
  REVIEW_TARGET_TYPES,
} from './valueSets';
import { listings } from './catalog';
import { stores } from './stores';
import { orders } from './commerce';

/**
 * A verified buyer's review of ONE target — a `listing`, a `store`, or a P2P
 * `seller` — with exactly the matching target-id column set.
 *
 * `listingId`/`storeId`/`orderId` carry an FK where the parent table exists
 * in this schema; `sellerOxyUserId` does not, because Oxy owns identity.
 * `onDelete: 'set null'` on all three: a review is evidence a buyer wrote,
 * and losing the row it points at should orphan the reference, not delete
 * the review — the same reasoning as `listings.categoryId`.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: generatedId(),
    authorOxyUserId: foreignServiceId().notNull(),
    targetType: text().notNull(),
    listingId: text().references(() => listings.id, { onDelete: 'set null' }),
    storeId: text().references(() => stores.id, { onDelete: 'set null' }),
    sellerOxyUserId: foreignServiceId(),
    orderId: text().references(() => orders.id, { onDelete: 'set null' }),
    /** The source bounds this `min: 1, max: 5`. */
    rating: integer().notNull(),
    title: text(),
    body: text(),
    status: text().notNull().default('published'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('reviews_target_type_check', table.targetType, REVIEW_TARGET_TYPES),
    closedSet('reviews_status_check', table.status, REVIEW_STATUSES),
    check('reviews_rating_check', sql`${table.rating} between 1 and 5`),
    // Per-target read indexes (filter by target + published, newest first).
    index('reviews_target_listing_status_created_idx').on(
      table.targetType,
      table.listingId,
      table.status,
      table.createdAt,
    ),
    index('reviews_target_store_status_created_idx').on(
      table.targetType,
      table.storeId,
      table.status,
      table.createdAt,
    ),
    index('reviews_target_seller_status_created_idx').on(
      table.targetType,
      table.sellerOxyUserId,
      table.status,
      table.createdAt,
    ),
    /**
     * One review per buyer per listing — the port of the source's
     * `{unique:true, partialFilterExpression:{listingId:{$exists:true}}}`.
     * Store/seller uniqueness stays a service-layer rule, same as the source.
     */
    uniqueIndex('reviews_author_listing_key')
      .on(table.authorOxyUserId, table.listingId)
      .where(sql`${table.listingId} is not null`),
  ],
);

/**
 * In-app feedback (bug/feature/improvement/other), optionally rated.
 *
 * Table name stays the mass noun `feedback`, not `feedbacks`. `metadata`
 * flattens to its three named sub-fields — the source declares exactly
 * those three and nothing else, so there is no open bag to model as jsonb.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    type: text().notNull(),
    /** The source bounds this `min: 1, max: 5` and leaves it optional. */
    rating: integer(),
    message: text().notNull(),
    email: text(),
    metadataPlatform: text(),
    metadataAppVersion: text(),
    metadataDeviceInfo: text(),
    status: text().notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('feedback_type_check', table.type, FEEDBACK_TYPES),
    closedSet('feedback_status_check', table.status, FEEDBACK_STATUSES),
    check('feedback_rating_check', sql`${table.rating} is null or ${table.rating} between 1 and 5`),
    index('feedback_oxy_user_created_idx').on(table.oxyUserId, table.createdAt),
    index('feedback_status_idx').on(table.status),
    index('feedback_type_idx').on(table.type),
  ],
);

/**
 * A device's push token, upsert-friendly per (user, token).
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    token: text().notNull(),
    deviceId: text(),
    platform: text(),
    active: boolean().notNull().default(true),
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('push_tokens_platform_check', table.platform, PUSH_PLATFORMS),
    // Upsert-friendly: each token is unique per user.
    uniqueIndex('push_tokens_oxy_user_token_key').on(table.oxyUserId, table.token),
    // Quick lookup by token alone for receipt error handling (e.g. DeviceNotRegistered).
    index('push_tokens_token_idx').on(table.token),
  ],
);

/**
 * A browser's Web Push subscription, unique per (user, endpoint).
 */
export const webPushSubscriptions = pgTable(
  'web_push_subscriptions',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    endpoint: text().notNull(),
    /** `keys.p256dh` / `keys.auth`, flattened — both required in the source. */
    keyP256dh: text().notNull(),
    keyAuth: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('web_push_subscriptions_oxy_user_endpoint_key').on(
      table.oxyUserId,
      table.endpoint,
    ),
  ],
);

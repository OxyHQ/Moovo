/**
 * Seller organizations — stores that list NEW products and the people who run
 * them — plus the marketplace-scoped profile of an individual P2P seller.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { closedSet, closedSetArray, foreignServiceId } from './columns';
import {
  CURRENCY_CODES,
  STORE_PERMISSIONS,
  STORE_ROLES,
  STORE_STATUSES,
  TEXT_TONES,
} from './valueSets';

/**
 * A seller organization that lists NEW inventory under a brand — distinct
 * from an individual P2P seller (`sellerProfiles` below), which has no brand
 * and no members.
 *
 * `policies.returnWindowDays`/`shippingNote` flatten to two plain columns:
 * the source nests them under one key that is only ever read and written
 * whole, so a jsonb blob would buy nothing here, and a flat column is what a
 * future CHECK or index would need to reach either one.
 */
export const stores = pgTable(
  'stores',
  {
    id: generatedId(),
    handle: text().notNull(),
    name: text().notNull(),
    /** NOT NULL, no database default — see `listings.description`. */
    description: text().notNull(),
    /** An Oxy media file id. Oxy owns identity/media: no FK. */
    logoFileId: foreignServiceId(),
    coverFileId: foreignServiceId(),
    brandColor: text().notNull(),
    textTone: text().notNull().default('light'),
    status: text().notNull().default('active'),
    policyReturnWindowDays: integer().notNull().default(30),
    policyShippingNote: text(),
    defaultCurrency: text().notNull().default('USD'),
    /**
     * An AVERAGE, so a float — `4.5` is the ordinary case. An integer column
     * would truncate every rating to its floor silently (the
     * `listings.rating` reasoning, ported verbatim).
     */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    productCount: integer().notNull().default(0),
    salesCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('stores_text_tone_check', table.textTone, TEXT_TONES),
    closedSet('stores_status_check', table.status, STORE_STATUSES),
    closedSet('stores_default_currency_check', table.defaultCurrency, CURRENCY_CODES),
    uniqueIndex('stores_handle_key').on(table.handle),
    index('stores_status_created_idx').on(table.status, table.createdAt),
  ],
);

/**
 * `stores.members`, as a CHILD TABLE rather than a jsonb array.
 *
 * The source indexes `members.oxyUserId` (`{'members.oxyUserId': 1}`), which
 * means the collection is QUERIED — "which stores is this person in" — the
 * same reason `product_variants` is a table and not a jsonb array on
 * `listings`: a queried collection gets a table, an opaque one gets jsonb.
 */
export const storeMembers = pgTable(
  'store_members',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** Oxy owns identity: no FK. */
    oxyUserId: foreignServiceId().notNull(),
    role: text().notNull(),
    permissions: text().array().notNull().default(sql`'{}'::text[]`),
    invitedBy: foreignServiceId(),
    /** The source's own field (`default: Date.now`), ported as a DB default. */
    joinedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('store_members_role_check', table.role, STORE_ROLES),
    closedSetArray('store_members_permissions_check', table.permissions, STORE_PERMISSIONS),
    // One membership per user per store — a plain unique index, not a
    // read-then-write check, so two concurrent invites can never both land.
    uniqueIndex('store_members_store_oxy_user_key').on(table.storeId, table.oxyUserId),
    index('store_members_oxy_user_idx').on(table.oxyUserId),
  ],
);

/**
 * The marketplace-scoped profile of an individual P2P seller, keyed by their
 * Oxy user id. Display name / username / avatar are NEVER stored here — read
 * live from the Oxy profile at hydration time.
 *
 * `shippingPrefs`/`returnPrefs` flatten to four nullable columns: the source
 * declares no defaults on any of their sub-fields, so "not yet set" has to
 * stay representable rather than collapsing to a default the seller never
 * chose.
 */
export const sellerProfiles = pgTable(
  'seller_profiles',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    isVerified: boolean().notNull().default(false),
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    salesCount: integer().notNull().default(0),
    shippingNote: text(),
    shippingHandlingDays: integer(),
    returnAccepts: boolean(),
    returnWindowDays: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('seller_profiles_oxy_user_key').on(table.oxyUserId)],
);

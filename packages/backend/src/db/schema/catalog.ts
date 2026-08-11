/**
 * The sellable catalogue: categories, listings and their buyable variants.
 */

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  closedSet,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
  moneyMinor,
} from './columns';
import { CURRENCY_CODES } from './valueSets';
import { stores } from './stores';

export const LISTING_OWNER_TYPES = ['user', 'store'] as const;
export const LISTING_CONDITIONS = ['new', 'used'] as const;
export const LISTING_STATUSES = ['draft', 'active', 'sold', 'archived'] as const;

/**
 * The marketplace taxonomy, a tree via `parentId`.
 *
 * `parentId` is a self-referencing foreign key. `ON DELETE RESTRICT` rather
 * than cascade: deleting a category with children should fail loudly and be
 * resolved by whoever is reorganising the tree, not silently delete an entire
 * subtree and orphan every listing tagged with its slugs.
 */
export const categories = pgTable(
  'categories',
  {
    id: generatedId(),
    name: text().notNull(),
    slug: text().notNull(),
    /** NULL for a top-level category — the source stores an explicit `null`. */
    parentId: text().references((): AnyPgColumn => categories.id, {
      onDelete: 'restrict',
    }),
    /** Materialized path: every ancestor slug, root → parent, excluding self. */
    ancestorSlugs: text().array().notNull().default(sql`'{}'::text[]`),
    imageUrl: text(),
    imageFileId: foreignServiceId(),
    position: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('categories_slug_key').on(table.slug),
    index('categories_parent_position_idx').on(table.parentId, table.position),
    // The source indexes the whole `ancestorSlugs` array for "everything under
    // this ancestor"; GIN is the array analogue of a Mongo multikey index.
    index('categories_ancestor_slugs_idx').using('gin', table.ancestorSlugs),
  ],
);

/**
 * The core sellable product.
 *
 * Owned EITHER by an individual user or by a store, enforced by
 * `listings_owner_shape_check` — the CHECK that replaces `listing.ts`'s
 * `pre('validate')` hook. The hook could never actually hold: two concurrent
 * writes both passed it and both saved. The constraint refuses the loser.
 *
 * `priceRange`, `hasInventory` and `variantCount` are DENORMALIZED from the
 * listing's variants so browse and sort run off indexed listing columns
 * without joining variants — the same reason the source denormalizes them.
 */
export const listings = pgTable(
  'listings',
  {
    id: generatedId(),
    ownerType: text().notNull(),
    /** Set exactly when `ownerType` is `user`. Oxy owns identity: no FK. */
    oxyUserId: foreignServiceId(),
    /** Set exactly when `ownerType` is `store`. */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    /**
     * NOT NULL with no DATABASE default, though the source declares
     * `default: ''`.
     *
     * `@oxyhq/db`'s invariant gate refuses an empty-string default across the
     * whole schema, because `''` is a VALUE standing in for absence — and a
     * value collides where a NULL does not. The source's `default: ''` is a
     * document-creation convenience, so the column stays NOT NULL (a listing
     * always has a description, possibly empty) while an INSERT that omits it
     * fails loudly instead of quietly inventing one.
     */
    description: text().notNull(),
    condition: text().notNull(),
    status: text().notNull().default('draft'),
    categoryId: text().references(() => categories.id, { onDelete: 'set null' }),
    /** Denormalized: the listing's own category slug plus every ancestor's. */
    categorySlugs: text().array().notNull().default(sql`'{}'::text[]`),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * `[{fileId, alt?, position}]` and `[{name, values[]}]`.
     *
     * jsonb rather than child tables: both are ordered value objects that are
     * only ever read and written WITH their listing, never queried across
     * listings and never joined. A child table would buy nothing and cost two
     * joins on the hottest read in the product.
     */
    images: jsonb().notNull().default(sql`'[]'::jsonb`),
    options: jsonb().notNull().default(sql`'[]'::jsonb`),
    priceMinAmount: moneyMinor(),
    priceMinCurrency: text(),
    priceMaxAmount: moneyMinor(),
    priceMaxCurrency: text(),
    hasInventory: boolean().notNull().default(false),
    variantCount: integer().notNull().default(0),
    /** Only set for P2P listings that carry a location. */
    latitude: latitude(),
    longitude: longitude(),
    location: generatedGeographyPoint('longitude', 'latitude'),
    /**
     * The port of `{title:'text', description:'text', tags:'text'}`.
     *
     * THREE halves, and the third exists because two were not enough.
     *
     * `to_tsvector` STEMS the prose; `array_to_tsvector` takes each tag as a
     * verbatim lexeme, which is what a tag is. But `plainto_tsquery` stems the
     * QUERY either way, so a verbatim-only tag was findable only when it was
     * already an English stem — measured on the server:
     *
     *     plainto_tsquery('english','watering')  ->  'water'
     *     array_to_tsvector(ARRAY['watering'])   ->  'watering'     no match
     *     array_to_tsvector(ARRAY['garden'])     vs  'garden'       match
     *
     * Mongo's `$text` index stemmed tag values too, so that was a functional
     * LOSS in the port rather than a faithful translation.
     *
     * The third term stems the tags as well, and is what actually makes tag
     * search work — including for a CAPITALISED tag, since `array_to_tsvector`
     * does not fold case while `plainto_tsquery` lowercases the query.
     *
     * WHAT THE VERBATIM TERM ACTUALLY CONTRIBUTES, corrected here because the
     * first version of this comment overstated it: nothing reachable. It was
     * kept to make the change strictly additive, on the reasoning that "a tag
     * answers to both its literal form and its stem". Measured on the server
     * afterwards, across 18 tag shapes (`garden`, `Garden`, `GARDEN`,
     * `watering`, `c++`, `50%`, `foo_bar`, `O'Brien`, `garden hose`, `the`,
     * `café`, `e-bike`, …), removing this term changes the outcome for NONE of
     * them — 0 disagreements, while the two vectors genuinely differ for 13, so
     * the comparison was not vacuous.
     *
     * The reason is structural: this term stores each tag EXACTLY as written,
     * and `plainto_tsquery` — the only way anything queries this column
     * (`catalogRepository.buildConditions`) — can never produce those forms. It
     * emits `garden` for `Garden`, `c` for `c++`, `water` for `watering`. A
     * literal-form lexeme is therefore matchable only when it coincides with
     * the stemmed form, in which case the third term already supplies it.
     *
     * So it is dead weight in the GIN index rather than a second matching
     * strategy. Left in place deliberately: removing it means changing a
     * generated column's expression, which `drizzle-kit generate` renders as
     * `DROP COLUMN` + `ADD COLUMN` and which destroys the index over it (see
     * the migration `0001` note below) — not worth that risk for an index-size
     * win nobody has measured as a problem. Anyone who does remove it needs the
     * `SET EXPRESSION` form and should keep the degenerate-input cases in
     * `catalog-reads.realdb.test.ts` green, which is where the 18-shape result
     * above is pinned from the outside.
     *
     * `array_to_string` is the obvious way to feed the tags to `to_tsvector`
     * and is STABLE, not IMMUTABLE (`provolatile = 's'`), so the server
     * refuses the generated column outright — as it does for `tags::text`.
     * `moovo_tags_text` is the immutable wrapper, created in the same
     * migration; joining a `text[]` with a constant separator really is
     * immutable, the general function is marked stable only because an
     * arbitrary element type's output function need not be.
     */
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')) || array_to_tsvector(coalesce(tags, '{}')) || to_tsvector('english', moovo_tags_text(coalesce(tags, '{}')))`,
    ),
    /**
     * An AVERAGE, so a float — `4.5` is the ordinary case. An integer column
     * here would truncate every rating to its floor silently.
     */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('listings_owner_type_check', table.ownerType, LISTING_OWNER_TYPES),
    closedSet('listings_condition_check', table.condition, LISTING_CONDITIONS),
    closedSet('listings_status_check', table.status, LISTING_STATUSES),
    closedSet('listings_price_min_currency_check', table.priceMinCurrency, CURRENCY_CODES),
    closedSet('listings_price_max_currency_check', table.priceMaxCurrency, CURRENCY_CODES),
    /**
     * `listing.ts`'s `pre('validate')` hook, as the database states it.
     *
     * A two-way split, unlike `jobs`: exactly one owner column is set, and
     * which one is decided by `ownerType`.
     */
    check(
      'listings_owner_shape_check',
      sql`(${table.ownerType} = 'user' and ${table.oxyUserId} is not null and ${table.storeId} is null)
       or (${table.ownerType} = 'store' and ${table.storeId} is not null and ${table.oxyUserId} is null)`,
    ),
    /**
     * A coordinate pair is both-or-neither.
     *
     * This is the one geo shape the SOURCE could not enforce: `listing.location`
     * is an inline nested object with no `required` on either sub-field and a
     * non-sparse `2dsphere` index, so a partial or empty location really is
     * persistable there — unlike `courier-profile.currentLocation`, which is a
     * named sub-schema with both fields required. The port closes that hole
     * rather than reproducing it.
     *
     * Because Mongo really did allow the shape, a BACKFILL would have had to
     * audit for partial and empty locations before this constraint met them.
     *
     * **There is no backfill: SETTLED 2026-08-10.** `listings` held 0 rows at
     * the final restore-verified dump (`counts-at-dump.json` in the archive)
     * and the source is destroyed, so no partial location exists to audit and
     * none can be created. See `CONVENTIONS.md` §"Constraints the source never
     * enforced".
     */
    check(
      'listings_location_shape_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    /** A price range is both-or-neither, per side. */
    check(
      'listings_price_min_shape_check',
      sql`(${table.priceMinAmount} is null) = (${table.priceMinCurrency} is null)`,
    ),
    check(
      'listings_price_max_shape_check',
      sql`(${table.priceMaxAmount} is null) = (${table.priceMaxCurrency} is null)`,
    ),
    index('listings_status_published_idx').on(table.status, table.publishedAt, table.id),
    index('listings_status_category_published_idx').on(
      table.status,
      table.categoryId,
      table.publishedAt,
      table.id,
    ),
    index('listings_category_slugs_idx').using('gin', table.categorySlugs),
    index('listings_status_price_published_idx').on(
      table.status,
      table.priceMinAmount,
      table.publishedAt,
    ),
    index('listings_store_status_published_idx').on(
      table.ownerType,
      table.storeId,
      table.status,
      table.publishedAt,
      table.id,
    ),
    index('listings_user_status_published_idx').on(
      table.ownerType,
      table.oxyUserId,
      table.status,
      table.publishedAt,
      table.id,
    ),
    /** The `2dsphere` index. GiST is what makes a radius filter an index scan. */
    index('listings_location_idx').using('gist', table.location),
    index('listings_search_vector_idx').using('gin', table.searchVector),
  ],
);

/**
 * A concrete buyable SKU of a listing.
 *
 * `committed` is units reserved by pending orders and is NEVER exposed on the
 * wire; it lives here because the inventory service's race-safe decrement
 * depends on both numbers being on one row.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    title: text().notNull().default('Default Title'),
    /** `[{name, value}]` — a value object read only with its variant. */
    optionValues: jsonb().notNull().default(sql`'[]'::jsonb`),
    sku: text(),
    priceAmount: moneyMinor().notNull(),
    priceCurrency: text().notNull(),
    compareAtAmount: moneyMinor(),
    compareAtCurrency: text(),
    inventoryTracked: boolean().notNull().default(true),
    inventoryAvailable: integer().notNull().default(0),
    inventoryCommitted: integer().notNull().default(0),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('product_variants_price_currency_check', table.priceCurrency, CURRENCY_CODES),
    closedSet(
      'product_variants_compare_at_currency_check',
      table.compareAtCurrency,
      CURRENCY_CODES,
    ),
    check(
      'product_variants_compare_at_shape_check',
      sql`(${table.compareAtAmount} is null) = (${table.compareAtCurrency} is null)`,
    ),
    index('product_variants_listing_position_idx').on(table.listingId, table.position),
    index('product_variants_listing_available_idx').on(
      table.listingId,
      table.inventoryAvailable,
    ),
    /**
     * `{sku: 1}, {sparse: true}` — NOT unique in the source, and it is not made
     * unique here. Two sellers may legitimately use the same SKU string.
     */
    index('product_variants_sku_idx').on(table.sku).where(sql`${table.sku} is not null`),
  ],
);

/**
 * The FUTURE multi-location inventory seam.
 *
 * Modelled because `product-variant.ts` defines it and `catalog-write.service`
 * writes an empty array at every call site, so the shape is already part of
 * the contract — but it is documented there as unused in F1 and is empty in
 * every write. A child table rather than jsonb because the moment it IS used,
 * "how much of this variant is at that location" is a per-location UPDATE, and
 * a jsonb array would make that a read-modify-write race.
 */
export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /** No `locations` table exists yet — see the deferred foreign-key ledger. */
    locationId: text().notNull(),
    available: integer().notNull().default(0),
    committed: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('inventory_levels_variant_location_key').on(table.variantId, table.locationId),
  ],
);

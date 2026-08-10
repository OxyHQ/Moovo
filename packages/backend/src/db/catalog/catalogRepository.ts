/**
 * Every statement the catalogue issues against `listings`, `product_variants`
 * and `categories`.
 *
 * ## Reads
 *
 * Four translations here are wrong in ways `tsc` and a mocked repository both
 * accept, and each was measured against the schema rather than assumed:
 *
 *  - **`{categorySlugs: 'x'}` is array CONTAINMENT, not equality.** Mongo
 *    matches a document whose array holds the value; the Postgres equivalent is
 *    `'x' = any(category_slugs)`. `eq()` compiles, runs, and matches NOTHING —
 *    so a category browse would silently return an empty page, which reads as
 *    "no listings in this category" rather than as a broken query.
 *  - **`ORDER BY published_at DESC` puts NULLs FIRST in Postgres.** Mongo sorts
 *    a missing value LAST on a descending sort, so a faithful port needs
 *    `DESC NULLS LAST` — otherwise every unpublished draft that leaked into an
 *    active filter would head the feed. Pinned by a test with a NULL-dated row.
 *  - **A keyset comparison with a NULL member yields NULL, not true**, so the
 *    two branches of the cursor boundary are written out rather than expressed
 *    as a row comparison. A row comparison drops every undated listing at the
 *    boundary and the page just comes back short.
 *  - **`$near` becomes `ST_DWithin` for the FILTER and `<->` for the ORDER.**
 *    Ordering by a `ST_Distance(...)` call cannot use the GiST index; the
 *    distance operator can. They return the same ordering at very different
 *    cost.
 *
 * ## Writes
 *
 * The write side reports `rowCount`, which behaves like Mongo's `matchedCount`
 * and NOT like `modifiedCount`. Every caller ported here consumed
 * `matchedCount` (`archiveListing`) or `deletedCount` (`removeVariant`), so a
 * plain predicate is the faithful port and no "would this actually change
 * anything" clause belongs in the WHERE. Re-archiving an already-archived
 * listing still matches, which is what the source did.
 *
 * `listings_owner_shape_check` replaces `listing.ts`'s `pre('validate')` hook
 * and is STRICTLY STRONGER: the hook only ran on `create`/`save`, so the
 * source's four `updateOne` paths could break the owner invariant silently.
 * The constraint covers them.
 */

import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ListingQuery } from '@moovo/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { categories, listings, productVariants } from '../schema/catalog';

export type ListingRow = typeof listings.$inferSelect;
export type ProductVariantRow = typeof productVariants.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;

/** A page of listings from the offset browse path. */
export interface OffsetListingPage {
  listings: ListingRow[];
  total: number;
}

/** A page of listings from the cursor browse path. */
export interface CursorListingPage {
  listings: ListingRow[];
  hasMore: boolean;
}

/**
 * Every predicate shared by both pagination paths.
 *
 * Geo wins over free text, exactly as the source chose: Mongo could not combine
 * `$near` with `$text` in one query, and preserving the precedence keeps the
 * two engines answering the same question rather than quietly widening the
 * result set here.
 */
function buildConditions(query: ListingQuery): SQL[] {
  const conditions: SQL[] = [eq(listings.status, 'active')];

  if (query.ownerType) conditions.push(eq(listings.ownerType, query.ownerType));
  if (query.storeId) conditions.push(eq(listings.storeId, query.storeId));
  if (query.condition) conditions.push(eq(listings.condition, query.condition));
  if (query.inStock) conditions.push(eq(listings.hasInventory, true));

  // CONTAINMENT. `eq()` here would compare the whole array to a scalar and
  // match nothing at all.
  if (query.category) {
    conditions.push(sql`${query.category} = any(${listings.categorySlugs})`);
  }

  if (typeof query.minPrice === 'number') {
    conditions.push(gte(listings.priceMinAmount, query.minPrice));
  }
  if (typeof query.maxPrice === 'number') {
    conditions.push(lte(listings.priceMinAmount, query.maxPrice));
  }

  if (query.near) {
    // `ST_DWithin` on geography takes METRES, which is what `radiusM` already
    // is — no conversion, and converting one would be silently wrong.
    conditions.push(
      sql`st_dwithin(${listings.location}, st_makepoint(${query.near.lng}, ${query.near.lat})::geography, ${query.near.radiusM})`,
    );
  } else if (query.q && query.q.trim().length > 0) {
    conditions.push(
      sql`${listings.searchVector} @@ plainto_tsquery('english', ${query.q.trim()})`,
    );
  }

  return conditions;
}

/**
 * The ORDER BY for a non-cursor browse.
 *
 * `NULLS LAST` on every descending date: Postgres orders NULLs first on a
 * DESC sort and Mongo orders a missing value last, so omitting it silently
 * reverses where undated rows appear.
 */
function buildOrderBy(query: ListingQuery): SQL[] {
  if (query.near) {
    // Nearest first. The distance OPERATOR, so the GiST index serves it.
    return [
      sql`${listings.location} <-> st_makepoint(${query.near.lng}, ${query.near.lat})::geography`,
      desc(listings.id),
    ];
  }
  switch (query.sort) {
    case 'price_asc':
      return [sql`${listings.priceMinAmount} asc nulls last`, desc(listings.id)];
    case 'price_desc':
      return [sql`${listings.priceMinAmount} desc nulls last`, desc(listings.id)];
    case 'newest':
    default:
      return [sql`${listings.publishedAt} desc nulls last`, desc(listings.id)];
  }
}

/** Offset-paginated browse, with the total the pagination envelope needs. */
export async function searchListingsOffset(
  query: ListingQuery,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<OffsetListingPage> {
  const where = and(...buildConditions(query));

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(...buildOrderBy(query))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { listings: rows, total: counted[0]?.total ?? 0 };
}

/**
 * Cursor-paginated browse over `(published_at desc nulls last, id desc)`.
 *
 * Reads `limit + 1` to answer `hasMore` without a second count, exactly as the
 * source did.
 */
export async function searchListingsCursor(
  query: ListingQuery,
  limit: number,
  cursor: { publishedAt: Date; id: string } | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<CursorListingPage> {
  const conditions = buildConditions(query);

  if (cursor !== null) {
    // Written out rather than as a row comparison: `(a, b) < (c, d)` yields
    // NULL when `a` is NULL, and a CHECK-free WHERE treats NULL as false, so
    // every undated listing would vanish at the page boundary.
    conditions.push(
      sql`(${listings.publishedAt} is null
           or ${listings.publishedAt} < ${cursor.publishedAt.toISOString()}::timestamptz
           or (${listings.publishedAt} = ${cursor.publishedAt.toISOString()}::timestamptz
               and ${listings.id} < ${cursor.id}))`,
    );
  }

  const rows = await db
    .select()
    .from(listings)
    .where(and(...conditions))
    .orderBy(sql`${listings.publishedAt} desc nulls last`, desc(listings.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return { listings: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/** One listing by id, or `null`. */
export async function findListingById(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRow | null> {
  const [row] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  return row ?? null;
}

/** Listings for a set of ids, in no particular order. */
export async function findListingsByIds(
  listingIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRow[]> {
  if (listingIds.length === 0) return [];
  return await db.select().from(listings).where(inArray(listings.id, listingIds));
}

/**
 * Listings owned by one seller, newest first.
 *
 * `ownerType` is stated explicitly alongside the owner id rather than left to
 * the shape CHECK: it is the difference between a person's inventory and a
 * store's, and this is the query where a widened CHECK would disclose one as
 * the other.
 */
export async function listListingsForOwner(
  owner: { ownerType: 'user'; oxyUserId: string } | { ownerType: 'store'; storeId: string },
  filter: { status?: string },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<OffsetListingPage> {
  const conditions: SQL[] = [eq(listings.ownerType, owner.ownerType)];
  conditions.push(
    owner.ownerType === 'user'
      ? eq(listings.oxyUserId, owner.oxyUserId)
      : eq(listings.storeId, owner.storeId),
  );
  if (filter.status) conditions.push(eq(listings.status, filter.status));

  const where = and(...conditions);
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(sql`${listings.publishedAt} desc nulls last`, desc(listings.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { listings: rows, total: counted[0]?.total ?? 0 };
}

/** Variants for a set of listings, ordered as the DTO presents them. */
export async function listVariantsForListings(
  listingIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductVariantRow[]> {
  if (listingIds.length === 0) return [];
  return await db
    .select()
    .from(productVariants)
    .where(inArray(productVariants.listingId, listingIds))
    .orderBy(productVariants.listingId, productVariants.position, productVariants.id);
}

/** Every active category, ordered for presentation. */
export async function listActiveCategories(
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow[]> {
  return await db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.position), asc(categories.name));
}

/** One category by its slug, or `null`. */
export async function findCategoryBySlug(
  slug: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow | null> {
  const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return row ?? null;
}

/** Every variant of ONE listing, in presentation order. */
export async function listVariantsForListing(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductVariantRow[]> {
  return await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId))
    .orderBy(productVariants.position, productVariants.id);
}

/** How many variants a listing has. */
export async function countVariants(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  // `count(*)::int` rather than a bare `count(*)`: postgres.js decodes `bigint`
  // as a STRING while drizzle types it `number`, so an uncast count would make
  // `existingCount + 1` string concatenation.
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));
  return row?.total ?? 0;
}

/**
 * How many of a store's TRACKED variants sit at or below `threshold`.
 *
 * One indexed join, where the source ran two round trips: `Listing.find(...)
 * .select('_id')` and then `ProductVariant.countDocuments({listingId: {$in:
 * […]}})`. That second query carried every one of the store's listing ids as a
 * literal, so it grew without bound with the catalogue; a join has no such
 * ceiling and cannot silently truncate.
 *
 * `inventoryTracked` is part of the predicate, not an afterthought: an
 * UNTRACKED variant has no stock level to be low, and counting it would report
 * a shortage for a product that cannot run out.
 */
export async function countLowStockVariantsForStore(
  storeId: string,
  threshold: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(listings, eq(productVariants.listingId, listings.id))
    .where(
      and(
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        eq(productVariants.inventoryTracked, true),
        lte(productVariants.inventoryAvailable, threshold),
      ),
    );
  return row?.total ?? 0;
}

/** One variant by id alone, or `null`. */
export async function findVariantById(
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductVariantRow | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return row ?? null;
}

/** One variant of a given listing, or `null`. Scoped so an id alone cannot reach it. */
export async function findVariant(
  listingId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductVariantRow | null> {
  const [row] = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)))
    .limit(1);
  return row ?? null;
}

/** The columns an insert supplies for a listing. */
export type NewListing = typeof listings.$inferInsert;

/** Insert a listing and return the stored row. */
export async function insertListing(
  values: NewListing,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRow> {
  const [row] = await db.insert(listings).values(values).returning();
  return row;
}

/** The columns an insert supplies for a variant. */
export type NewProductVariant = typeof productVariants.$inferInsert;

/** Insert one or more variants and return the stored rows. */
export async function insertVariants(
  values: NewProductVariant[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductVariantRow[]> {
  if (values.length === 0) return [];
  return await db.insert(productVariants).values(values).returning();
}

/** The listing columns an update may set. */
export interface ListingPatch {
  title?: string;
  description?: string;
  condition?: string;
  status?: string;
  categoryId?: string;
  categorySlugs?: string[];
  tags?: string[];
  images?: unknown;
  publishedAt?: Date;
}

/**
 * Apply a patch to a listing. Returns whether the row existed.
 *
 * `matchedCount` semantics: a patch that changes nothing still reports the row
 * as found, which is what the source's `matchedCount === 0` test meant.
 */
export async function updateListingRow(
  listingId: string,
  patch: ListingPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.id, listingId))
      .limit(1);
    return row !== undefined;
  }
  const result = await db.update(listings).set(patch).where(eq(listings.id, listingId));
  // `count`, never `rows.length` — the latter is 0 for an UPDATE either way.
  return (result.count ?? 0) > 0;
}

/** The denormalized facets `syncListingFacets` recomputes. */
export interface ListingFacets {
  priceMinAmount: number | null;
  priceMinCurrency: string | null;
  priceMaxAmount: number | null;
  priceMaxCurrency: string | null;
  hasInventory: boolean;
  variantCount: number;
}

/** Persist the denormalized facets derived from a listing's variants. */
export async function updateListingFacets(
  listingId: string,
  facets: ListingFacets,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(listings).set(facets).where(eq(listings.id, listingId));
}

/** The variant columns an update may set. */
export interface ProductVariantPatch {
  title?: string;
  sku?: string | null;
  priceAmount?: number;
  priceCurrency?: string;
  compareAtAmount?: number | null;
  compareAtCurrency?: string | null;
  optionValues?: unknown;
  inventoryTracked?: boolean;
  inventoryAvailable?: number;
}

/** Apply a patch to one variant of a listing. Returns whether the row existed. */
export async function updateVariantRow(
  listingId: string,
  variantId: string,
  patch: ProductVariantPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (Object.keys(patch).length === 0) {
    return (await findVariant(listingId, variantId, db)) !== null;
  }
  const result = await db
    .update(productVariants)
    .set(patch)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)));
  return (result.count ?? 0) > 0;
}

/** Delete one variant of a listing. Returns whether a row was removed. */
export async function deleteVariantRow(
  listingId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .delete(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.listingId, listingId)));
  return (result.count ?? 0) > 0;
}

/**
 * Atomically reserve `qty` units of a TRACKED variant.
 *
 * The guard is in the WHERE clause, so the loser of a race matches no row and
 * the caller sees `false` — the same compare-and-set the source expressed as a
 * filtered `updateOne` with `$inc`. Reading, checking and writing separately
 * would reintroduce the race the source had already closed.
 */
export async function reserveVariantStock(
  variantId: string,
  qty: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(productVariants)
    .set({
      inventoryAvailable: sql`${productVariants.inventoryAvailable} - ${qty}`,
      inventoryCommitted: sql`${productVariants.inventoryCommitted} + ${qty}`,
    })
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.inventoryTracked, true),
        gte(productVariants.inventoryAvailable, qty),
      ),
    );
  return (result.count ?? 0) > 0;
}

/**
 * Move a TRACKED variant's stock counters by the given deltas.
 *
 * Unguarded beyond `tracked`, matching the source: `commit`, `release` and
 * `restock` all applied their `$inc` without an availability test because the
 * reservation that preceded them already established the units exist. Only
 * `reserve` needs the compare-and-set, and it has its own function.
 */
export async function adjustVariantStock(
  variantId: string,
  deltas: { available?: number; committed?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const columns: Record<string, SQL> = {};
  if (deltas.available !== undefined) {
    columns.inventoryAvailable = sql`${productVariants.inventoryAvailable} + ${deltas.available}`;
  }
  if (deltas.committed !== undefined) {
    columns.inventoryCommitted = sql`${productVariants.inventoryCommitted} + ${deltas.committed}`;
  }
  if (Object.keys(columns).length === 0) return;

  await db
    .update(productVariants)
    .set(columns)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.inventoryTracked, true)));
}

/**
 * Every READ the catalogue browse and detail paths issue.
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

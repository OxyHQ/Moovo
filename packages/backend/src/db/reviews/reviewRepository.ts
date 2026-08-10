/**
 * Every statement the reviews domain issues against `reviews`.
 *
 * ## A target is one of three columns, and that shape is load-bearing
 *
 * `targetType` selects which of `listingId` / `storeId` / `sellerOxyUserId`
 * carries the target — the port of the source's computed `targetIdField()`.
 * Every read and the aggregate go through {@link targetPredicate} so a caller
 * cannot filter on `targetType` alone and silently match another target's
 * reviews, which is what a hand-written `eq(reviews.listingId, id)` without the
 * type would do for a store review whose `listingId` is NULL.
 *
 * ## The one-per-target rule is TWO different things
 *
 * `reviews_author_listing_key` is a PARTIAL unique index and covers listings
 * only, exactly as the source's `partialFilterExpression` did. Store and seller
 * uniqueness was a service-layer read-then-write in the source and stays one —
 * porting it to a unique index would be a new constraint on rows nobody has
 * checked, and the schema notes say so.
 *
 * So {@link insertReview} answers a listing duplicate with `null` (the index
 * decides, at commit time) while the service keeps its pre-check for the other
 * two. The `where` on the `ON CONFLICT` is the index predicate and is required
 * rather than decorative: naming a partial index without repeating its
 * predicate is `42P10` at runtime.
 */

import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { reviews } from '../schema/engagement';

export type ReviewRow = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

/** The three things a review can be about. */
export type ReviewTargetKind = 'listing' | 'store' | 'seller';

/**
 * The predicate selecting one target's reviews.
 *
 * `targetType` is stated alongside the id rather than left implicit: without
 * it, a seller whose Oxy user id happened to equal a store id would collect
 * both, and more practically a NULL column would match nothing in a way that
 * reads as "no reviews yet".
 */
function targetPredicate(kind: ReviewTargetKind, targetId: string) {
  switch (kind) {
    case 'listing':
      return and(eq(reviews.targetType, 'listing'), eq(reviews.listingId, targetId));
    case 'store':
      return and(eq(reviews.targetType, 'store'), eq(reviews.storeId, targetId));
    case 'seller':
      return and(eq(reviews.targetType, 'seller'), eq(reviews.sellerOxyUserId, targetId));
  }
}

/** The column a target id is written to, for a given target type. */
export function targetColumnFor(kind: ReviewTargetKind): 'listingId' | 'storeId' | 'sellerOxyUserId' {
  switch (kind) {
    case 'listing':
      return 'listingId';
    case 'store':
      return 'storeId';
    case 'seller':
      return 'sellerOxyUserId';
  }
}

/** This author's review of this target, or `null`. The one-per-target pre-check. */
export async function findReviewByAuthorAndTarget(
  authorOxyUserId: string,
  kind: ReviewTargetKind,
  targetId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRow | null> {
  const [row] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.authorOxyUserId, authorOxyUserId), targetPredicate(kind, targetId)))
    .limit(1);
  return row ?? null;
}

/**
 * Insert a review, or `null` when this author has already reviewed this
 * LISTING.
 *
 * The null path exists only for listings, because
 * `reviews_author_listing_key` is the only uniqueness the database enforces.
 * A raised `23505` would abort the surrounding transaction (`25P02`) and take
 * any recovery read with it, so the conflict is expressed as an absent row.
 */
export async function insertReview(
  values: NewReview,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewRow | null> {
  const [row] = await db
    .insert(reviews)
    .values(values)
    .onConflictDoNothing({
      target: [reviews.authorOxyUserId, reviews.listingId],
      // The INDEX PREDICATE of the partial unique, not a row filter.
      where: isNotNull(reviews.listingId),
    })
    .returning();
  return row ?? null;
}

/** A page of a target's published reviews plus the total matching count. */
export interface ReviewPageRows {
  rows: ReviewRow[];
  total: number;
}

/**
 * One target's PUBLISHED reviews, newest first.
 *
 * `desc(createdAt)` carries an explicit `nulls last`: the column is NOT NULL so
 * it cannot bite today, but Postgres orders NULLs FIRST under `DESC` where
 * Mongo puts a missing value last, and a page headed by undated rows is the
 * failure shape this port keeps meeting.
 */
export async function listPublishedReviewsForTarget(
  kind: ReviewTargetKind,
  targetId: string,
  { page, limit }: { page: number; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewPageRows> {
  const where = and(targetPredicate(kind, targetId), eq(reviews.status, 'published'));

  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(sql`${reviews.createdAt} desc nulls last`, desc(reviews.id))
      .offset((page - 1) * limit)
      .limit(limit),
    // `count(*)::int` rather than a bare `count(*)`: postgres.js decodes
    // `bigint` as a STRING while drizzle types it `number`.
    db.select({ total: sql<number>`count(*)::int` }).from(reviews).where(where),
  ]);

  return { rows, total: counted?.total ?? 0 };
}

/** A target's rating aggregate over its PUBLISHED reviews. */
export interface RatingAggregateRow {
  average: number;
  count: number;
}

/**
 * Average rating and review count over a target's PUBLISHED reviews.
 *
 * `avg(...)` is cast to `double precision` in SQL: postgres.js hands back
 * `numeric` as a STRING while drizzle types it `number`, so an uncast average
 * makes the rounding that follows string arithmetic. `count(*)::int` for the
 * same reason.
 *
 * A target with no published reviews yields `{average: 0, count: 0}` — the
 * source's `group?.count ?? 0`. Zero here means "nothing to average", and the
 * caller writes 0/0 onto the target rather than leaving a stale aggregate
 * standing after the last review is withdrawn.
 */
export async function aggregateForTarget(
  kind: ReviewTargetKind,
  targetId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RatingAggregateRow> {
  const [row] = await db
    .select({
      average: sql<number>`coalesce(avg(${reviews.rating}), 0)::double precision`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(and(targetPredicate(kind, targetId), eq(reviews.status, 'published')));

  return { average: row?.average ?? 0, count: row?.count ?? 0 };
}

/** One distinct review target that currently has published reviews. */
export interface ReviewTargetRef {
  targetType: ReviewTargetKind;
  targetId: string;
}

/**
 * Every distinct target with at least one PUBLISHED review — the drift sweep's
 * working set.
 *
 * The source built this with a `$switch` inside a `$group`; here the target id
 * is the non-null one of the three columns, chosen by `targetType`. Rows whose
 * selected column is NULL are excluded rather than grouped under a null key:
 * the source's `$switch` had a `default: null` branch and then filtered, and a
 * null target id is not a target.
 */
export async function listPublishedReviewTargets(
  db: DatabaseOrTransaction = getDb(),
): Promise<ReviewTargetRef[]> {
  const targetId = sql<string>`
    case ${reviews.targetType}
      when 'listing' then ${reviews.listingId}
      when 'store' then ${reviews.storeId}
      when 'seller' then ${reviews.sellerOxyUserId}
    end`;

  const rows = await db
    .selectDistinct({ targetType: reviews.targetType, targetId })
    .from(reviews)
    .where(and(eq(reviews.status, 'published'), sql`${targetId} is not null`))
    .orderBy(asc(reviews.targetType), asc(targetId));

  return rows.map((row) => ({
    targetType: row.targetType as ReviewTargetKind,
    targetId: row.targetId,
  }));
}

/**
 * Every statement the seller-profile domain issues against `seller_profiles`.
 *
 * Both writes are upserts, and they are DIFFERENT SHAPES of upsert — porting
 * them to one spelling would break one of them:
 *
 *  - `ensureSellerProfile` is the source's `$setOnInsert`-only upsert, so it is
 *    `ON CONFLICT DO NOTHING`. On an existing row that is a genuine no-op, and
 *    the empty `RETURNING` set IS the "already there" answer — followed by a
 *    read, because the caller needs the row either way.
 *  - `updateSellerPrefs` is a HYBRID (`$setOnInsert` for the key, `$set` for the
 *    preferences), so it is `ON CONFLICT DO UPDATE` over exactly the preference
 *    columns. Writing `DO NOTHING` here would silently discard every edit made
 *    after the profile first existed, which is every edit but the first.
 *
 * **A preference GROUP is replaced wholesale, not merged.** The source assigns
 * `shippingPrefs`/`returnPrefs` as whole sub-objects, so submitting
 * `{note: 'x'}` clears `handlingDays`. The flattened columns must reproduce
 * that: when a group is present, BOTH its columns are written, with an absent
 * member becoming NULL. Merging instead would look tidier and would quietly
 * preserve a value the seller had just cleared.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { sellerProfiles } from '../schema/stores';

/** A `seller_profiles` row as the domain consumes it. */
export interface SellerProfileRecord {
  id: string;
  oxyUserId: string;
  isVerified: boolean;
  rating: number;
  reviewCount: number;
  salesCount: number;
  shippingPrefs?: { note?: string; handlingDays?: number };
  returnPrefs?: { accepts?: boolean; windowDays?: number };
  createdAt: Date;
  updatedAt: Date;
}

type SellerProfileRow = typeof sellerProfiles.$inferSelect;

/**
 * Reassemble the two preference groups from their flat columns.
 *
 * A group is emitted only when at least one of its columns is set, so "never
 * configured" stays distinguishable from "configured to nothing" — the reason
 * the columns are nullable rather than defaulted (`db/schema/CONVENTIONS.md`).
 */
function toRecord(row: SellerProfileRow): SellerProfileRecord {
  const shipping: { note?: string; handlingDays?: number } = {};
  if (row.shippingNote !== null) shipping.note = row.shippingNote;
  if (row.shippingHandlingDays !== null) shipping.handlingDays = row.shippingHandlingDays;

  const returns: { accepts?: boolean; windowDays?: number } = {};
  if (row.returnAccepts !== null) returns.accepts = row.returnAccepts;
  if (row.returnWindowDays !== null) returns.windowDays = row.returnWindowDays;

  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    isVerified: row.isVerified,
    rating: row.rating,
    reviewCount: row.reviewCount,
    salesCount: row.salesCount,
    ...(Object.keys(shipping).length > 0 ? { shippingPrefs: shipping } : {}),
    ...(Object.keys(returns).length > 0 ? { returnPrefs: returns } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The profile for `oxyUserId`, created empty on first use.
 *
 * Idempotent under concurrent first-writes: the loser of the race inserts
 * nothing and reads the winner's row.
 */
export async function ensureSellerProfile(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord> {
  const inserted = await db
    .insert(sellerProfiles)
    .values({ oxyUserId })
    .onConflictDoNothing({ target: sellerProfiles.oxyUserId })
    .returning();

  if (inserted.length > 0) return toRecord(inserted[0]);

  const [existing] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.oxyUserId, oxyUserId))
    .limit(1);
  return toRecord(existing);
}

/**
 * Move a P2P seller's denormalized `salesCount` by `delta`, creating the
 * profile if they have none yet.
 *
 * The port of `SellerProfile.updateOne({oxyUserId}, {$inc:{salesCount:1}},
 * {upsert:true})`, and the upsert is the whole reason this is not a plain
 * UPDATE: a seller's FIRST sale is the common case in which no profile row
 * exists, and an UPDATE would move zero rows and lose that sale silently.
 *
 * On the insert path the row is created with `salesCount` already at `delta`;
 * on the conflict path the increment reads the STORED column, so two concurrent
 * sales cannot both read the same starting value.
 */
export async function incrementSellerSalesCount(
  oxyUserId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(sellerProfiles)
    .values({ oxyUserId, salesCount: delta })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: { salesCount: sql`${sellerProfiles.salesCount} + ${delta}` },
    });
}

/**
 * Set a P2P seller's denormalized rating aggregate, creating the profile if
 * they have none yet.
 *
 * The upsert is the source's `{upsert: true}` and it matters: a seller's first
 * review arrives before any profile row exists, and a plain UPDATE would move
 * zero rows and drop the aggregate silently.
 */
export async function setSellerRating(
  oxyUserId: string,
  aggregate: { rating: number; reviewCount: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(sellerProfiles)
    .values({ oxyUserId, rating: aggregate.rating, reviewCount: aggregate.reviewCount })
    .onConflictDoUpdate({
      target: sellerProfiles.oxyUserId,
      set: { rating: aggregate.rating, reviewCount: aggregate.reviewCount },
    });
}

/**
 * Profiles for a set of Oxy user ids, in no particular order.
 *
 * A READ, unlike `ensureSellerProfile` beside it: listing hydration must not
 * create a profile as a side effect of somebody browsing. A seller with no row
 * is simply absent from the result, and the DTO builder already falls back to
 * the Oxy identity for that case.
 */
export async function findSellerProfilesByUserIds(
  oxyUserIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord[]> {
  if (oxyUserIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sellerProfiles)
    .where(inArray(sellerProfiles.oxyUserId, oxyUserIds));
  return rows.map(toRecord);
}

/** The preference groups a caller may submit. */
export interface SellerPrefsPatch {
  shippingPrefs?: { note?: string; handlingDays?: number };
  returnPrefs?: { accepts?: boolean; windowDays?: number };
}

/** Set the seller's preferences, creating the profile if it does not exist. */
export async function updateSellerPrefs(
  oxyUserId: string,
  prefs: SellerPrefsPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerProfileRecord> {
  // A present group replaces BOTH its columns; an absent member of a present
  // group becomes NULL. See the header — this mirrors the source's wholesale
  // sub-object assignment rather than merging.
  const columns: Partial<typeof sellerProfiles.$inferInsert> = {};
  if (prefs.shippingPrefs !== undefined) {
    columns.shippingNote = prefs.shippingPrefs.note ?? null;
    columns.shippingHandlingDays = prefs.shippingPrefs.handlingDays ?? null;
  }
  if (prefs.returnPrefs !== undefined) {
    columns.returnAccepts = prefs.returnPrefs.accepts ?? null;
    columns.returnWindowDays = prefs.returnPrefs.windowDays ?? null;
  }

  // Nothing to set: the source still upserts the key, so a first call with an
  // empty patch must create the profile rather than 404.
  if (Object.keys(columns).length === 0) {
    return ensureSellerProfile(oxyUserId, db);
  }

  const [row] = await db
    .insert(sellerProfiles)
    .values({ oxyUserId, ...columns })
    .onConflictDoUpdate({ target: sellerProfiles.oxyUserId, set: columns })
    .returning();

  return toRecord(row);
}

/**
 * Every statement this service issues against `shipments`.
 *
 * The table is flat and its consumers are nested, so every function here
 * returns a {@link ShipmentRecord} rather than a row — `shipmentShape.ts` owns
 * that translation and this module owns the SQL. Nothing outside these two
 * files should know that `pickup` is eleven columns.
 *
 * Two things worth knowing before changing anything here:
 *
 *  - **No caller reads an update's row count.** All four source update sites
 *    (`quote.service`'s distance write and status flip, `job.service`'s booking
 *    pair) discard the result of `updateOne`, so the `modifiedCount` vs
 *    `matchedCount` question that decides most of these ports simply does not
 *    arise. What DOES port is the CAS predicate on the status flip, which is
 *    load-bearing and is written out below.
 *  - **The two `Number(...)` coercions are belt-and-braces, and that is a
 *    MEASURED claim rather than the usual one.** postgres.js decodes `int8` as
 *    a string, so the folklore is that every count needs coercing. Measured
 *    against this server: drizzle's `count()` helper maps its own result, so it
 *    already yields `2`; `jsonb_array_length` is `int4`, which decodes as a
 *    number anyway. The string really does appear one respelling away — a raw
 *    `` sql`count(*)` `` returns `"0"`, as does the driver directly — so the
 *    coercions stay, because they cost nothing and keep both functions total if
 *    somebody reaches for the raw spelling. What they must NOT be mistaken for
 *    is proof that a trap was caught here: mutation-testing removed each in
 *    turn and the suite stayed green, correctly. The assertion that discriminates
 *    is in `shipment-quote.realdb.test.ts`, and it pins the raw spelling's
 *    string decoding directly so this reasoning cannot rot into a comment.
 */

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { shipments } from '../schema/transport';
import {
  toShipmentColumns,
  toShipmentRecord,
  type NewShipment,
  type ShipmentRecord,
} from './shipmentShape';

/** Which shipments a list request wants. */
export interface ShipmentListFilter {
  senderOxyUserId: string;
  status?: string | undefined;
  type?: string | undefined;
}

/** Offset pagination, as the source's `skip`/`limit` expressed it. */
export interface ShipmentListPage {
  page: number;
  limit: number;
}

function listPredicate(filter: ShipmentListFilter) {
  return and(
    eq(shipments.senderOxyUserId, filter.senderOxyUserId),
    ...(filter.status ? [eq(shipments.status, filter.status)] : []),
    ...(filter.type ? [eq(shipments.type, filter.type)] : []),
  );
}

/** Create a shipment. The id is minted here so the caller can log it. */
export async function insertShipment(
  input: NewShipment,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShipmentRecord> {
  const [row] = await db
    .insert(shipments)
    .values({ id: uuidv7(), ...toShipmentColumns(input) })
    .returning();
  if (!row) {
    throw new Error('Inserting a shipment returned no row');
  }
  return toShipmentRecord(row);
}

/** One shipment by id, or null. Ownership is the CALLER's check, as in the source. */
export async function findShipmentById(
  shipmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShipmentRecord | null> {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  return row ? toShipmentRecord(row) : null;
}

/**
 * The sender's own shipments, newest first.
 *
 * `id` breaks ties on `createdAt`, which the source's `{createdAt: -1}` left
 * unbroken. Two shipments created in the same microsecond would otherwise page
 * in an arbitrary order, and an offset paginator with an unstable order can
 * show a row twice or skip it entirely. `id` is uuid v7 and is NOT monotonic
 * within a millisecond — it is used here only to make the order TOTAL, never to
 * mean creation order, which is what `createdAt` is for and why it leads.
 */
export async function listShipmentsForSender(
  filter: ShipmentListFilter,
  { page, limit }: ShipmentListPage,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShipmentRecord[]> {
  const rows = await db
    .select()
    .from(shipments)
    .where(listPredicate(filter))
    .orderBy(desc(shipments.createdAt), desc(shipments.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return rows.map(toShipmentRecord);
}

/**
 * How many shipments match, for the paginated response's `total`.
 *
 * Uses drizzle's `count()` helper deliberately: it maps its own result to a
 * number, where a raw `` sql`count(*)` `` would hand the response a string. The
 * `Number(...)` is redundant TODAY and kept as a guard on the respelling — see
 * the module header, which records the measurement rather than the folklore.
 */
export async function countShipmentsForSender(
  filter: ShipmentListFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(shipments).where(listPredicate(filter));
  return Number(row?.total ?? 0);
}

/** Persist the computed pickup→dropoff distance. */
export async function updateShipmentDistance(
  shipmentId: string,
  distanceM: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(shipments).set({ distanceM }).where(eq(shipments.id, shipmentId));
}

/**
 * Flip a shipment to `quoted`, but only from a pre-quote status.
 *
 * The `in ('draft', 'quoting')` predicate is the source's
 * `{status: {$in: ['draft','quoting']}}` and is load-bearing: without it a
 * late-returning provider adapter could move an already-`booked` or
 * already-`cancelled` shipment back to `quoted`. No caller reads the count, so
 * the guard is the whole point of the statement — dropping it would still
 * "work" on every happy path.
 */
export async function markShipmentQuoted(
  shipmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(shipments)
    .set({ status: 'quoted' })
    .where(and(eq(shipments.id, shipmentId), inArray(shipments.status, ['draft', 'quoting'])));
}

/** Record the booking: the shipment is `booked` and points at its job and quote. */
export async function markShipmentBooked(
  shipmentId: string,
  { jobId, quoteRef }: { jobId: string; quoteRef: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(shipments)
    .set({ status: 'booked', jobId, quoteRef })
    .where(eq(shipments.id, shipmentId));
}

/**
 * Cancel a shipment, returning the updated record.
 *
 * The source loaded a non-lean document, checked three conditions in JS, set
 * the field and saved. The conditions stay in the SERVICE — they each raise a
 * distinct typed error a controller maps to a distinct response, which a single
 * WHERE clause could not express — so this is the plain write that follows
 * them, returning the row so the service need not re-read it.
 */
export async function markShipmentCancelled(
  shipmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShipmentRecord | null> {
  const [row] = await db
    .update(shipments)
    .set({ status: 'cancelled' })
    .where(eq(shipments.id, shipmentId))
    .returning();
  return row ? toShipmentRecord(row) : null;
}

/**
 * The projection `delivery-context.ts` attaches to a moderation case.
 *
 * A narrow SELECT rather than the whole row, and the narrowing is the point:
 * the source used `.select('itemDescription photos type distanceM')` so that a
 * contact name, a phone number and two street addresses are never even LOADED
 * into a process that is assembling material for a stranger to read. A
 * `select()` here would still be redacted downstream, but "not fetched" is a
 * stronger guarantee than "not passed on", and it is the one the source chose.
 */
export interface ShipmentModerationFacts {
  id: string;
  type: string;
  itemDescription: string;
  photoCount: number;
  distanceM: number | null;
}

export async function findShipmentModerationFacts(
  shipmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShipmentModerationFacts | null> {
  const [row] = await db
    .select({
      id: shipments.id,
      type: shipments.type,
      itemDescription: shipments.itemDescription,
      /**
       * Counted in SQL rather than by fetching the array. `jsonb_array_length`
       * refuses a non-array, which cannot occur behind the column's own
       * `'[]'::jsonb` default and NOT NULL, and the count is all the caller
       * shows a jury — the file ids themselves are exactly what must not travel.
       */
      photoCount: sql<number>`jsonb_array_length(${shipments.photos})`,
      distanceM: shipments.distanceM,
    })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  if (!row) return null;
  return { ...row, photoCount: Number(row.photoCount) };
}

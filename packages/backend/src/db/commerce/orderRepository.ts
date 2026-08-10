/**
 * Every statement the order domain issues against `orders`, `order_items` and
 * `order_status_events`.
 *
 * ## The status transition is a COMPARE-AND-SET and must stay one
 *
 * `transitionOrderStatus` guards on the CURRENT status inside the WHERE clause,
 * so only one caller can move an order out of a given status. Everything the
 * order service does afterwards — committing inventory, restocking, bumping a
 * seller's `salesCount` — runs only for the winner, which is what makes those
 * effects happen AT MOST ONCE when a buyer's cancel races the expire sweep.
 *
 * **Reading the row, comparing the status in JavaScript and then updating would
 * pass every non-concurrent test and lose the property entirely.** It is the
 * same shape as `reserveVariantStock` in the catalogue repository, and it is
 * asserted the same way: two concurrent transitions, exactly one winner.
 *
 * ## The status history is a table, and it is append-only by construction
 *
 * The source pushed onto a `{_id:false}` sub-document array in the same
 * `findOneAndUpdate` as the status flip. Here the event is a row inserted after
 * the CAS wins — which is safe precisely BECAUSE the CAS already excluded every
 * other writer, so no second event can interleave for the same transition.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { orderItems, orderStatusEvents, orders } from '../schema/commerce';

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderStatusEventRow = typeof orderStatusEvents.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type NewOrderItem = typeof orderItems.$inferInsert;

/** An order with its lines and status trail. */
export interface OrderRecord {
  order: OrderRow;
  items: OrderItemRow[];
  statusHistory: OrderStatusEventRow[];
}

/** Lines of one order, in presentation order. */
async function itemsOf(orderId: string, db: DatabaseOrTransaction): Promise<OrderItemRow[]> {
  return await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.position), asc(orderItems.id));
}

/**
 * The status trail of one order, oldest first.
 *
 * `(at, id)` rather than `at` alone: the source's array had no other ordering
 * field, and two events written in the same millisecond would otherwise come
 * back in an arbitrary order — `@oxyhq/db`'s uuid v7 is NOT monotonic within a
 * millisecond, so the id tiebreaker is what makes this deterministic.
 */
async function historyOf(
  orderId: string,
  db: DatabaseOrTransaction,
): Promise<OrderStatusEventRow[]> {
  return await db
    .select()
    .from(orderStatusEvents)
    .where(eq(orderStatusEvents.orderId, orderId))
    .orderBy(asc(orderStatusEvents.at), asc(orderStatusEvents.id));
}

/** Assemble the full record for one order id, or `null`. */
export async function findOrderById(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order === undefined) return null;
  const [items, statusHistory] = await Promise.all([itemsOf(order.id, db), historyOf(order.id, db)]);
  return { order, items, statusHistory };
}

/** The ownership scopes an order lookup may be constrained by. */
export type OrderScope =
  | { kind: 'buyer'; oxyUserId: string }
  | { kind: 'seller'; oxyUserId: string }
  | { kind: 'store'; storeId: string };

/**
 * Turn a scope into its predicate.
 *
 * The seller scope states `sellerType = 'user'` alongside the id rather than
 * relying on the shape CHECK: it is the difference between a person's orders
 * and a store's, and this is where a widened CHECK would disclose one as the
 * other.
 */
function scopePredicate(scope: OrderScope): SQL {
  switch (scope.kind) {
    case 'buyer':
      return eq(orders.buyerOxyUserId, scope.oxyUserId);
    case 'seller':
      return and(
        eq(orders.sellerType, 'user'),
        eq(orders.sellerOxyUserId, scope.oxyUserId),
      ) as SQL;
    case 'store':
      return eq(orders.storeId, scope.storeId);
  }
}

/** One order, only if it falls inside `scope`. */
export async function findScopedOrder(
  orderId: string,
  scope: OrderScope,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), scopePredicate(scope)))
    .limit(1);
  if (order === undefined) return null;
  const [items, statusHistory] = await Promise.all([itemsOf(order.id, db), historyOf(order.id, db)]);
  return { order, items, statusHistory };
}

/** A page of orders plus the total matching count. */
export interface OrderPage {
  orders: OrderRow[];
  items: Map<string, OrderItemRow[]>;
  total: number;
}

/**
 * Orders in `scope`, newest first, with every page row's lines batch-loaded.
 *
 * The lines come back in ONE statement grouped in memory rather than per order:
 * summarizing a page of orders is the hottest read the seller dashboard makes.
 */
export async function listScopedOrders(
  scope: OrderScope,
  filter: { status?: string },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPage> {
  const conditions: SQL[] = [scopePredicate(scope)];
  if (filter.status) conditions.push(eq(orders.status, filter.status));
  const where = and(...conditions);

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)::int` }).from(orders).where(where),
  ]);

  const items = new Map<string, OrderItemRow[]>();
  if (rows.length > 0) {
    const lines = await db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(orderItems.position), asc(orderItems.id));
    for (const line of lines) {
      const bucket = items.get(line.orderId);
      if (bucket) bucket.push(line);
      else items.set(line.orderId, [line]);
    }
  }

  return { orders: rows, items, total: counted[0]?.total ?? 0 };
}

/** Insert an order and its lines together. */
export async function insertOrder(
  order: NewOrder,
  lines: Omit<NewOrderItem, 'orderId'>[],
  openingEvent?: StatusEventInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRow | null> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values(order)
      .onConflictDoNothing({
        target: orders.idempotencyKey,
        // The INDEX PREDICATE, not a row filter. `orders_idempotency_key_key`
        // is PARTIAL, and an `ON CONFLICT` naming a partial index without
        // repeating its predicate is `42P10` at runtime.
        where: sql`${orders.idempotencyKey} is not null`,
      })
      .returning();

    // The key was already taken — a replayed or concurrent checkout. Returning
    // null rather than throwing is load-bearing: the source read this off
    // Mongo's E11000 and then read the prior order back, and that recovery
    // cannot port. A failing INSERT aborts the whole transaction (25P02) and
    // takes the recovery read with it, so the conflict has to be expressed as
    // an absent row instead of an error.
    //
    // The target names the column deliberately. A bare `DO NOTHING` would also
    // swallow an `orders_order_number_key` collision, which is a real bug that
    // must surface.
    if (row === undefined) return null;

    if (lines.length > 0) {
      await tx.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: row.id })));
    }

    // Optional because only checkout opens an order's trail; the seeds in the
    // tests insert orders whose history starts empty.
    if (openingEvent) {
      await tx.insert(orderStatusEvents).values({
        orderId: row.id,
        status: openingEvent.status,
        ...(openingEvent.byOxyUserId === undefined
          ? {}
          : { byOxyUserId: openingEvent.byOxyUserId }),
        ...(openingEvent.note === undefined ? {} : { note: openingEvent.note }),
      });
    }

    return row;
  });
}

/**
 * One order by its checkout idempotency key, scoped to the buyer.
 *
 * The other half of {@link insertOrder}'s null: having learned the key was
 * taken, checkout converges on the group that took it.
 */
export async function findOrderByIdempotencyKey(
  idempotencyKey: string,
  buyerOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.idempotencyKey, idempotencyKey),
        eq(orders.buyerOxyUserId, buyerOxyUserId),
      ),
    )
    .limit(1);
  if (order === undefined) return null;
  const [items, statusHistory] = await Promise.all([itemsOf(order.id, db), historyOf(order.id, db)]);
  return { order, items, statusHistory };
}

/** Every order of one checkout group belonging to a buyer, oldest first. */
export async function listOrdersByCheckoutGroup(
  checkoutGroupId: string,
  buyerOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.checkoutGroupId, checkoutGroupId),
        eq(orders.buyerOxyUserId, buyerOxyUserId),
      ),
    )
    .orderBy(asc(orders.createdAt), asc(orders.id));
  if (rows.length === 0) return [];

  const lines = await db
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(orderItems.position), asc(orderItems.id));

  const byOrder = new Map<string, OrderItemRow[]>();
  for (const line of lines) {
    const bucket = byOrder.get(line.orderId);
    if (bucket) bucket.push(line);
    else byOrder.set(line.orderId, [line]);
  }

  return rows.map((order) => ({
    order,
    items: byOrder.get(order.id) ?? [],
    statusHistory: [],
  }));
}

/** The order columns a transition may set alongside `status`. */
export interface OrderTransitionPatch {
  paymentStatus?: string;
  paidAt?: Date;
  trackingNumber?: string;
}

/** A status event to append when a transition wins. */
export interface StatusEventInput {
  status: string;
  byOxyUserId?: string;
  note?: string;
}

/**
 * Move an order from `from` to `to`, atomically, appending the status event.
 *
 * Returns the updated row, or `null` when the order was NOT at `from` — which
 * is the caller's signal that somebody else transitioned it first. The guard is
 * `eq(orders.status, from)` inside the WHERE clause: two concurrent callers
 * cannot both match.
 *
 * The event insert follows the UPDATE inside one transaction. It cannot
 * interleave with a competing transition's event, because the loser's UPDATE
 * matched no row and it never reaches this point.
 */
export async function transitionOrderStatus(
  orderId: string,
  from: string,
  to: string,
  patch: OrderTransitionPatch,
  event: StatusEventInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRow | null> {
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({ status: to, ...patch })
      .where(and(eq(orders.id, orderId), eq(orders.status, from)))
      .returning();

    // The CAS lost: the order had already left `from`. Nothing is written, and
    // the caller must not run the side-effects.
    if (updated.length === 0) return null;

    await tx.insert(orderStatusEvents).values({
      orderId,
      status: event.status,
      ...(event.byOxyUserId === undefined ? {} : { byOxyUserId: event.byOxyUserId }),
      ...(event.note === undefined ? {} : { note: event.note }),
    });

    return updated[0];
  });
}

/** Per-status order counts for one store. */
export async function countStoreOrdersByStatus(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({ status: orders.status, n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.storeId, storeId))
    .groupBy(orders.status);
  return new Map(rows.map((r) => [r.status, r.n]));
}

/**
 * The paid-order revenue total for one store, per currency.
 *
 * `::bigint` would come back a STRING through postgres.js while drizzle types
 * it `number`, so the sum is cast to `numeric` and then to a JS number in SQL —
 * `sum(...)::bigint` reaching JS as `"1200"` makes `total + x` string
 * concatenation, silently, and only on a sum large enough to notice.
 */
export async function sumStorePaidRevenue(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      currency: orders.grandTotalCurrency,
      total: sql<number>`(sum(${orders.grandTotalAmount}))::double precision`,
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), eq(orders.paymentStatus, 'paid')))
    .groupBy(orders.grandTotalCurrency);
  return new Map(rows.map((r) => [r.currency, r.total]));
}

/** Orders still awaiting payment older than `cutoff` — the expiry sweep's input. */
export async function findStaleUnpaidOrders(
  cutoff: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, 'pending_payment'),
        // An ISO string with an explicit cast: a bare `Date` interpolated into
        // a raw template fails at SERIALISATION in the driver, with an error
        // that does not name the cause.
        sql`${orders.createdAt} < ${cutoff.toISOString()}::timestamptz`,
      ),
    );
  if (rows.length === 0) return [];

  const lines = await db
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(orderItems.position), asc(orderItems.id));

  const byOrder = new Map<string, OrderItemRow[]>();
  for (const line of lines) {
    const bucket = byOrder.get(line.orderId);
    if (bucket) bucket.push(line);
    else byOrder.set(line.orderId, [line]);
  }

  return rows.map((order) => ({
    order,
    items: byOrder.get(order.id) ?? [],
    statusHistory: [],
  }));
}

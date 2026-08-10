/**
 * Order service — order lifecycle transitions, queries, and store stats.
 *
 * `transition` is the single gate for moving an order between statuses: it
 * enforces the allowed-transition graph and runs the matching inventory effect
 * via `inventory.service` (commit on pay; restock vs release on cancel/refund
 * depending on whether stock was already committed). It NEVER copies aggregate
 * counts — seller `salesCount` moves ±1 in lockstep with real paid orders.
 *
 * Order DTOs are built ONLY through `order-hydration.service`; this service
 * loads the right records and delegates serialization.
 */

import type {
  Money,
  Order as OrderDTO,
  OrderStatus,
  OrderSummary,
} from '@moovo/shared-types';
import {
  countStoreOrdersByStatus,
  findScopedOrder,
  listScopedOrders,
  sumStorePaidRevenue,
  transitionOrderStatus,
  type OrderRecord,
  type OrderScope,
} from '../db/commerce/orderRepository.js';
import { countLowStockVariantsForStore } from '../db/catalog/catalogRepository.js';
import { findStoreById, incrementStoreSalesCount } from '../db/stores/storeRepository.js';
import { incrementSellerSalesCount } from '../db/stores/sellerProfileRepository.js';
import { commit, release, restock } from './inventory.service.js';
import { hydrateOrders, summarizeOrders } from './order-hydration.service.js';
import { enqueueOrderEvent } from '../queue/producers.js';
import type { OrderEvent } from '../queue/types.js';
import { zeroMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * The allowed status transitions. A transition NOT listed under the current
 * status is a CONFLICT. `cancelled`/`refunded` are terminal.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled', 'refunded'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

/**
 * Map a transitioned-to status to the buyer/seller notification event, or
 * `undefined` when the status has no notification (e.g. `processing`,
 * `refunded`). Drives the best-effort order-event enqueue at the end of
 * `transition`.
 */
const STATUS_TO_EVENT: Partial<Record<OrderStatus, OrderEvent>> = {
  paid: 'paid',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** Options for a `transition` call. */
interface TransitionOptions {
  /** Oxy user id of the actor driving the transition (recorded in history). */
  actorOxyUserId?: string;
  /** Optional free-text note recorded on the status event. */
  note?: string;
  /** Tracking number to attach (e.g. when moving to `shipped`). */
  trackingNumber?: string;
}

/**
 * Transition an order to `next`, enforcing the allowed-transition graph and
 * running the matching inventory effect:
 *   - `paid`: commit every line (sale finalized) + bump the seller's salesCount.
 *   - `cancelled`/`refunded`: per line, RESTOCK if already paid (stock was
 *     committed) else RELEASE the reservation; `refunded` also marks payment
 *     refunded.
 *
 * The status flip is `transitionOrderStatus`, whose guard is a compare-and-swap
 * IN THE WHERE CLAUSE and whose status-trail entry commits in the same
 * transaction — the source did both in one document update, so a status that
 * moved with nothing recording it was unrepresentable.
 *
 * Only the winning caller runs the side-effects, so a buyer `cancel` racing the
 * expire-reservations sweep — or any multi-process double-invoke — runs them AT
 * MOST ONCE: the loser's CAS matches no row and this throws CONFLICT before
 * touching inventory.
 *
 * The inventory effects and the `salesCount` bump run AFTER that transaction
 * commits, not inside it — exactly where the source had them. Folding them in
 * would make an `inventory.service` failure roll back the status change, which
 * is a behaviour the source does not have.
 *
 * Returns the updated record; callers hydrate from it.
 */
export async function transition(
  record: OrderRecord,
  next: OrderStatus,
  opts: TransitionOptions,
): Promise<OrderRecord> {
  const current = record.order.status as OrderStatus;
  if (!TRANSITIONS[current].includes(next)) {
    throw conflict(`Cannot transition order from ${current} to ${next}`);
  }

  // The pre-transition payment state drives restock-vs-release on cancel/refund.
  const wasPaid = record.order.paymentStatus === 'paid';
  const at = new Date();

  const updated = await transitionOrderStatus(
    record.order.id,
    current,
    next,
    {
      ...(next === 'paid' ? { paymentStatus: 'paid', paidAt: at } : {}),
      ...(next === 'refunded' ? { paymentStatus: 'refunded' } : {}),
      ...(opts.trackingNumber ? { trackingNumber: opts.trackingNumber } : {}),
    },
    {
      status: next,
      ...(opts.actorOxyUserId ? { byOxyUserId: opts.actorOxyUserId } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    },
  );

  if (!updated) {
    throw conflict(`Order ${record.order.id} was concurrently transitioned`);
  }

  // CAS won — run the inventory side-effects + salesCount bump exactly once.
  if (next === 'paid') {
    for (const item of record.items) {
      await commit(item.variantId, item.quantity);
    }
    if (record.order.sellerType === 'user' && record.order.sellerOxyUserId) {
      await incrementSellerSalesCount(record.order.sellerOxyUserId, 1);
    } else if (record.order.sellerType === 'store' && record.order.storeId) {
      await incrementStoreSalesCount(record.order.storeId, 1);
    }
  } else if (next === 'cancelled' || next === 'refunded') {
    for (const item of record.items) {
      if (wasPaid) {
        await restock(item.variantId, item.quantity);
      } else {
        await release(item.variantId, item.quantity);
      }
    }
  }

  log.general.info(
    { orderId: record.order.id, status: next, actor: opts.actorOxyUserId },
    'Order transitioned',
  );

  // Best-effort: notify buyer + seller of the lifecycle change. `processing`
  // has no buyer-facing event, so it is skipped. A notification failure must
  // never fail the transition.
  const orderEvent = STATUS_TO_EVENT[next];
  if (orderEvent) {
    try {
      await enqueueOrderEvent({ orderId: record.order.id, event: orderEvent });
    } catch (err) {
      log.general.warn(
        { err, orderId: record.order.id, status: next },
        'Failed to enqueue order-event notification',
      );
    }
  }

  // The persisted row the CAS returned, with the trail entry it just wrote
  // appended — so a caller hydrating the result sees the new state without a
  // second read.
  return {
    order: updated,
    items: record.items,
    statusHistory: [
      ...record.statusHistory,
      {
        id: '',
        orderId: record.order.id,
        status: next,
        at,
        byOxyUserId: opts.actorOxyUserId ?? null,
        note: opts.note ?? null,
      },
    ],
  };
}

/** A page of order summaries plus the total matching count (controller paginates). */
interface OrderPage {
  data: OrderSummary[];
  total: number;
}

/** Offset-paginated list parameters. */
interface ListParams {
  page: number;
  limit: number;
  status?: OrderStatus;
}

/** Summarize a scoped page of orders. */
async function summarizeScoped(
  scope: OrderScope,
  { page, limit, status }: ListParams,
): Promise<OrderPage> {
  const result = await listScopedOrders(
    scope,
    status ? { status } : {},
    page,
    limit,
  );
  const records: OrderRecord[] = result.orders.map((order) => ({
    order,
    items: result.items.get(order.id) ?? [],
    // A summary needs no trail, and the page read deliberately does not fetch
    // one. `hydrateOrders` is what serves the full order.
    statusHistory: [],
  }));
  return { data: await summarizeOrders(records), total: result.total };
}

/** List the buyer's own orders (newest first), summarized + total count. */
export async function getBuyerOrders(oxyUserId: string, params: ListParams): Promise<OrderPage> {
  return await summarizeScoped({ kind: 'buyer', oxyUserId }, params);
}

/** List a P2P seller's orders (optionally filtered by status), summarized. */
export async function getSellerOrders(oxyUserId: string, params: ListParams): Promise<OrderPage> {
  return await summarizeScoped({ kind: 'seller', oxyUserId }, params);
}

/** List a store's orders (optionally filtered by status), summarized. */
export async function getStoreOrders(storeId: string, params: ListParams): Promise<OrderPage> {
  return await summarizeScoped({ kind: 'store', storeId }, params);
}

/** Load an order inside `scope`, or throw NOT_FOUND. */
async function loadScoped(orderId: string, scope: OrderScope): Promise<OrderRecord> {
  const record = await findScopedOrder(orderId, scope);
  if (!record) {
    throw notFound('Order not found');
  }
  return record;
}

/** Hydrate one order record into its DTO, or throw NOT_FOUND. */
async function hydrateOne(record: OrderRecord): Promise<OrderDTO> {
  const [dto] = await hydrateOrders([record]);
  if (!dto) {
    throw notFound('Order not found');
  }
  return dto;
}

/** Get a single order owned by the buyer (hydrated), or throw NOT_FOUND. */
export async function getOrderForBuyer(oxyUserId: string, id: string): Promise<OrderDTO> {
  return await hydrateOne(await loadScoped(id, { kind: 'buyer', oxyUserId }));
}

/** Get a single order owned by the store (hydrated), or throw NOT_FOUND. */
export async function getOrderForStore(storeId: string, id: string): Promise<OrderDTO> {
  return await hydrateOne(await loadScoped(id, { kind: 'store', storeId }));
}

/**
 * Test-only mock pay: move the buyer's order to `paid`. 404s (hidden) when the
 * mock-pay endpoint is disabled (production).
 */
export async function mockPay(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  if (!config.orders.mockPayEnabled) {
    throw notFound('Not found');
  }
  const record = await loadScoped(orderId, { kind: 'buyer', oxyUserId });
  const updated = await transition(record, 'paid', {
    actorOxyUserId: oxyUserId,
    note: 'mock-pay',
  });
  return await hydrateOne(updated);
}

/** Cancel the buyer's own order (releases the reservation if still unpaid). */
export async function cancelByBuyer(oxyUserId: string, orderId: string): Promise<OrderDTO> {
  const record = await loadScoped(orderId, { kind: 'buyer', oxyUserId });
  const updated = await transition(record, 'cancelled', {
    actorOxyUserId: oxyUserId,
    note: 'cancelled by buyer',
  });
  return await hydrateOne(updated);
}

/** Fulfilment update params for a P2P seller. */
interface SellerFulfilInput {
  status: 'processing' | 'shipped' | 'delivered';
  trackingNumber?: string;
}

/** Advance a P2P seller's order along the fulfilment path (processing/shipped/delivered). */
export async function fulfillSellerOrder(
  oxyUserId: string,
  orderId: string,
  { status, trackingNumber }: SellerFulfilInput,
): Promise<OrderDTO> {
  const record = await loadScoped(orderId, { kind: 'seller', oxyUserId });
  const updated = await transition(record, status, {
    actorOxyUserId: oxyUserId,
    ...(trackingNumber ? { trackingNumber } : {}),
  });
  return await hydrateOne(updated);
}

/** Status-patch params for a store order. */
interface StoreStatusInput {
  status: OrderStatus;
  trackingNumber?: string;
  note?: string;
}

/** Patch a store order's status (any allowed transition; records the actor). */
export async function patchStoreOrderStatus(
  storeId: string,
  orderId: string,
  { status, trackingNumber, note }: StoreStatusInput,
  actorOxyUserId: string,
): Promise<OrderDTO> {
  const record = await loadScoped(orderId, { kind: 'store', storeId });
  const updated = await transition(record, status, {
    actorOxyUserId,
    ...(trackingNumber ? { trackingNumber } : {}),
    ...(note ? { note } : {}),
  });
  return await hydrateOne(updated);
}

/** A store's order dashboard stats. */
interface StoreStats {
  counts: Record<OrderStatus, number>;
  revenue: Money;
  lowStockVariantCount: number;
}

/** Every order status initialized to a zero count. */
function zeroCounts(): Record<OrderStatus, number> {
  return {
    pending_payment: 0,
    paid: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
  };
}

/**
 * Compute a store's order dashboard stats: per-status order counts, paid-order
 * revenue (in the store's default currency), and the number of tracked variants
 * at or below the low-stock threshold.
 *
 * `sumStorePaidRevenue` totals PER CURRENCY, and only the store's own
 * `defaultCurrency` bucket is reported. A store holding orders in two
 * currencies has two totals and adding them would be meaningless — so the
 * others are left out rather than folded in.
 */
export async function storeStats(storeId: string): Promise<StoreStats> {
  const counts = zeroCounts();

  const [statusCounts, store, revenueByCurrency, lowStockVariantCount] = await Promise.all([
    countStoreOrdersByStatus(storeId),
    findStoreById(storeId),
    sumStorePaidRevenue(storeId),
    countLowStockVariantsForStore(storeId, config.orders.lowStockThreshold),
  ]);

  for (const [status, n] of statusCounts) {
    if (status in counts) {
      counts[status as OrderStatus] = n;
    }
  }

  const currency = (store?.defaultCurrency ??
    [...revenueByCurrency.keys()][0] ??
    'USD') as Money['currency'];
  const total = revenueByCurrency.get(currency);
  const revenue: Money =
    total === undefined ? zeroMoney(currency) : { amount: total, currency };

  return { counts, revenue, lowStockVariantCount };
}

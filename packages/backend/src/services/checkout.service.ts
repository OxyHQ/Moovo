/**
 * Checkout service — turn the buyer's cart into immutable orders.
 *
 * A multi-seller cart is SPLIT into one order per seller (a `store:<id>` or a
 * `user:<id>` group), all sharing a `checkoutGroupId`. Every line's stock is
 * reserved up front across ALL groups; if ANY reservation fails the whole
 * checkout is rolled back (every prior reservation released) and nothing is
 * created — checkout is all-or-nothing.
 *
 * Idempotency is layered: a Redis SETNX claim is the fast path (replay returns
 * the original orders), and the durable backstop is the per-order partial-unique
 * `idempotencyKey`, on which a replay converges rather than creating duplicates.
 * Redis is best-effort: any Redis failure logs a warning and falls through to
 * the durable database path — it NEVER breaks checkout.
 *
 * ## Each order commits alone, and that is the source's shape
 *
 * One order plus its lines plus its opening status event go in ONE transaction,
 * because they were ONE Mongo document. There is deliberately NO transaction
 * spanning the seller groups: `Order.create` was called per group with no
 * atomicity between them, and `rollbackReservations` is built on that. Widening
 * the boundary here would be a silent behaviour change dressed as a port.
 */

import { randomUUID } from 'node:crypto';
import type {
  CheckoutInput,
  CheckoutResult,
  Money,
  ShippingMethod,
  OrderSellerType,
} from '@moovo/shared-types';
import type { Cart } from '@moovo/shared-types';
import {
  findOrderByIdempotencyKey,
  insertOrder,
  listOrdersByCheckoutGroup,
  type NewOrder,
  type NewOrderItem,
  type OrderRecord,
} from '../db/commerce/orderRepository.js';
import {
  findListingsByIds,
  listVariantsForListings,
  type ListingRow,
  type ProductVariantRow,
} from '../db/catalog/catalogRepository.js';
import { findAddressForUser, type AddressRow } from '../db/addresses/addressRepository.js';
import { nextOrderNumber } from '../db/sequences/numberRepository.js';
import { getCart, clearCart } from './cart.service.js';
import { reserve, release } from './inventory.service.js';
import { summarizeOrders } from './order-hydration.service.js';
import { resolveMedia } from './media.service.js';
import { multiplyMoney, addMoney, sumMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { getRedisClient, withRedisTimeout } from '../lib/redis.js';
import { enqueueOrderEvent } from '../queue/producers.js';
import { conflict, notFound, isMoovoError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Human label shown for each shipping method on the order. */
const SHIPPING_LABELS: Record<ShippingMethod, string> = {
  standard: 'Standard shipping',
  express: 'Express shipping',
  pickup: 'Pickup',
};

/** Sentinel value held in the Redis idempotency key while a checkout is in flight. */
const IDEMPOTENCY_PENDING = '__pending__';
/** Redis key prefix for checkout idempotency claims. */
const IDEMPOTENCY_KEY_PREFIX = 'checkout:';

/** A reservation made during this checkout attempt (for rollback). */
interface Reservation {
  variantId: string;
  qty: number;
}

/** A cart line resolved against its live listing + variant for snapshotting. */
interface ResolvedLine {
  cartItem: Cart['items'][number];
  listing: ListingRow;
  variant: ProductVariantRow;
}

/** A per-seller group of resolved lines that becomes one order. */
interface SellerGroup {
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  lines: ResolvedLine[];
}

/**
 * The immutable shipping destination, as the flattened `ship_to_*` columns.
 *
 * Copied at checkout and never re-read, so a later edit of the saved `Address`
 * cannot mutate a placed order — which is why these are columns on the order
 * rather than a reference to the address row.
 */
type ShipToColumns = Pick<
  NewOrder,
  | 'shipToLabel'
  | 'shipToRecipientName'
  | 'shipToLine1'
  | 'shipToLine2'
  | 'shipToCity'
  | 'shipToRegion'
  | 'shipToPostalCode'
  | 'shipToCountry'
  | 'shipToPhone'
>;

function snapshotAddress(address: AddressRow): ShipToColumns {
  return {
    shipToRecipientName: address.recipientName,
    shipToLine1: address.line1,
    shipToCity: address.city,
    shipToPostalCode: address.postalCode,
    shipToCountry: address.country,
    shipToLabel: address.label ?? null,
    shipToLine2: address.line2 ?? null,
    shipToRegion: address.region ?? null,
    shipToPhone: address.phone ?? null,
  };
}

/** The stable seller group key for a listing (`store:<id>` or `user:<id>`). */
function sellerKeyForListing(listing: ListingRow): string {
  return listing.ownerType === 'store'
    ? `store:${String(listing.storeId)}`
    : `user:${String(listing.oxyUserId)}`;
}

/** First listing image (lowest position), resolved through the media chokepoint. */
function firstImageUrl(listing: ListingRow): string | undefined {
  const images = (listing.images ?? []) as { fileId: string; position: number }[];
  if (images.length === 0) {
    return undefined;
  }
  const first = [...images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/** Release every reservation made so far, swallowing (and warning) per-release failures. */
async function rollbackReservations(reserved: Reservation[]): Promise<void> {
  for (const r of reserved) {
    try {
      await release(r.variantId, r.qty);
    } catch (relErr) {
      log.general.warn(
        { err: relErr, variantId: r.variantId },
        'Failed to release reservation during checkout rollback',
      );
    }
  }
}

/** Look up the orders of a prior checkout group and summarize them. */
async function summarizePriorGroup(
  oxyUserId: string,
  checkoutGroupId: string,
): Promise<CheckoutResult> {
  const prior = await listOrdersByCheckoutGroup(checkoutGroupId, oxyUserId);
  return { checkoutGroupId, orders: await summarizeOrders(prior) };
}

/**
 * Build the immutable line item snapshots for a group: title/variant/options/
 * unit price are frozen here and never re-read after the order is placed.
 */
function buildItems(group: SellerGroup): Omit<NewOrderItem, 'orderId'>[] {
  return group.lines.map(({ cartItem, listing, variant }, position) => {
    const unitPrice: Money = cartItem.unitPrice;
    const lineTotal = multiplyMoney(unitPrice, cartItem.quantity);
    return {
      listingId: listing.id,
      variantId: variant.id,
      title: listing.title,
      variantTitle: variant.title,
      imageUrl: firstImageUrl(listing) ?? null,
      optionValues: ((variant.optionValues ?? []) as { name: string; value: string }[]).map((o) => ({
        name: o.name,
        value: o.value,
      })),
      unitPriceAmount: unitPrice.amount,
      unitPriceCurrency: unitPrice.currency,
      quantity: cartItem.quantity,
      lineTotalAmount: lineTotal.amount,
      lineTotalCurrency: lineTotal.currency,
      // Explicit because the source's line items were an array whose insertion
      // order was the only identity a line ever had.
      position,
    };
  });
}

/**
 * Place orders from the buyer's current cart.
 *
 * @param oxyUserId - The buyer.
 * @param input - The shipping address + optional per-seller shipping selections.
 * @param idempotencyKey - Optional client-supplied key; a replay with the same
 *   key returns the original orders instead of creating duplicates.
 */
export async function checkout(
  oxyUserId: string,
  input: CheckoutInput,
  idempotencyKey?: string,
): Promise<CheckoutResult> {
  // 1. Redis idempotency fast-path (best-effort; never breaks checkout).
  const redis = idempotencyKey ? getRedisClient() : null;
  const redisKey = idempotencyKey ? `${IDEMPOTENCY_KEY_PREFIX}${oxyUserId}:${idempotencyKey}` : null;
  let holdsRedisClaim = false;

  if (redis && redisKey) {
    try {
      const claim = await withRedisTimeout(
        redis.set(redisKey, IDEMPOTENCY_PENDING, 'PX', config.orders.idempotencyTtlMs, 'NX'),
      );
      if (claim === null) {
        const stored = await withRedisTimeout(redis.get(redisKey));
        if (stored && stored !== IDEMPOTENCY_PENDING) {
          const prior = await listOrdersByCheckoutGroup(stored, oxyUserId);
          if (prior.length > 0) {
            return { checkoutGroupId: stored, orders: await summarizeOrders(prior) };
          }
        } else if (stored === IDEMPOTENCY_PENDING) {
          throw conflict('Checkout already in progress');
        }
      } else {
        holdsRedisClaim = true;
      }
    } catch (err) {
      if (isMoovoError(err)) {
        throw err;
      }
      log.general.warn({ err }, 'Redis idempotency fast-path failed; falling back to durable path');
    }
  }

  // 2. Load + validate the cart.
  const cart = await getCart(oxyUserId);
  if (cart.items.length === 0) {
    throw conflict('Cart is empty');
  }
  if (cart.items.some((item) => item.stale === true)) {
    throw conflict('Cart has stale items; please review your cart');
  }
  if (cart.items.some((item) => item.unitPrice.currency !== cart.currency)) {
    throw conflict('Cart currency mismatch');
  }

  // 3. Resolve + snapshot the shipping address.
  const address = await findAddressForUser(oxyUserId, input.addressId);
  if (!address) {
    throw notFound('Address not found');
  }
  const shippingAddressSnapshot = snapshotAddress(address);

  // 4. Load listings + variants for every cart line; group by seller.
  const listingIds = [...new Set(cart.items.map((i) => i.listingId))];
  const [listingRows, variantRows] = await Promise.all([
    findListingsByIds(listingIds),
    listVariantsForListings(listingIds),
  ]);
  const listingById = new Map(listingRows.map((l) => [l.id, l]));
  const variantById = new Map(variantRows.map((v) => [v.id, v]));

  const groups = new Map<string, SellerGroup>();
  for (const cartItem of cart.items) {
    const listing = listingById.get(cartItem.listingId);
    const variant = variantById.get(cartItem.variantId);
    if (!listing || !variant) {
      throw conflict('Cart references an item that no longer exists');
    }
    const key = sellerKeyForListing(listing);
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push({ cartItem, listing, variant });
    } else {
      groups.set(key, {
        sellerType: listing.ownerType === 'store' ? 'store' : 'user',
        ...(listing.ownerType === 'store'
          ? { storeId: String(listing.storeId) }
          : { sellerOxyUserId: String(listing.oxyUserId) }),
        lines: [{ cartItem, listing, variant }],
      });
    }
  }

  // 5. Reserve every line across ALL groups; roll back on any failure.
  const reserved: Reservation[] = [];
  try {
    for (const group of groups.values()) {
      for (const line of group.lines) {
        await reserve(line.cartItem.variantId, line.cartItem.quantity);
        reserved.push({ variantId: line.cartItem.variantId, qty: line.cartItem.quantity });
      }
    }
  } catch (err) {
    await rollbackReservations(reserved);
    throw err;
  }

  // 6-7. Build + create one order per group.
  //
  // The group id was a Mongo ObjectId string; it is an opaque handle the client
  // round-trips, and `validateEntityId` already accepts both id shapes, so a
  // uuid serves the same purpose without keeping a bson dependency alive for it.
  const checkoutGroupId = randomUUID();
  const groupEntries = [...groups.entries()];
  const created: OrderRecord[] = [];
  /**
   * Set when a group's `idempotencyKey` was already taken. Handled AFTER the
   * try block, not inside it: the conflict path does its own rollback, and a
   * `throw` from inside would be caught by the `catch` below and release every
   * reservation a SECOND time — which is not a no-op, it is stock invented out
   * of nothing.
   */
  let idempotencyConflict = false;

  try {
    for (const [sellerKey, group] of groupEntries) {
      const method = input.shippingSelections?.[sellerKey] ?? 'standard';
      const cost: Money = { amount: config.orders.shippingRates[method], currency: cart.currency };
      const items = buildItems(group);
      const subtotal = sumMoney(
        items.map((i) => ({
          amount: i.lineTotalAmount,
          currency: i.lineTotalCurrency as Money['currency'],
        })),
        cart.currency,
      );
      const grandTotal = addMoney(subtotal, cost);
      const orderNumber = await nextOrderNumber();

      // One order, its lines and its opening status event in ONE transaction —
      // they were one Mongo document. There is deliberately no transaction
      // spanning the groups; see this file's header.
      const order = await insertOrder(
        {
          orderNumber,
          buyerOxyUserId: oxyUserId,
          sellerType: group.sellerType,
          sellerOxyUserId: group.sellerOxyUserId ?? null,
          storeId: group.storeId ?? null,
          ...shippingAddressSnapshot,
          shippingMethod: method,
          shippingLabel: SHIPPING_LABELS[method],
          shippingCostAmount: cost.amount,
          shippingCostCurrency: cost.currency,
          subtotalAmount: subtotal.amount,
          subtotalCurrency: subtotal.currency,
          grandTotalAmount: grandTotal.amount,
          grandTotalCurrency: grandTotal.currency,
          checkoutGroupId,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:${sellerKey}` : null,
        },
        items,
        { status: 'pending_payment', byOxyUserId: oxyUserId },
      );

      // A NULL order means the idempotency key was already taken: a concurrent
      // or replayed checkout already created this group.
      //
      // The source read this off Mongo's E11000. There is no error to catch
      // here BY DESIGN — see `insertOrder`: a failing INSERT would
      // abort the surrounding transaction (25P02) and take the recovery read
      // with it, so the conflict is expressed as an absent row instead.
      if (!order) {
        idempotencyConflict = true;
        break;
      }

      created.push({ order, items: [], statusHistory: [] });
    }
  } catch (err) {
    // Any create failure: release reservations and rethrow.
    await rollbackReservations(reserved);
    throw err;
  }

  // Roll back THIS attempt's reservations and converge on the prior group.
  if (idempotencyConflict) {
    await rollbackReservations(reserved);
    if (idempotencyKey && groupEntries.length > 0) {
      const sampleKey = `${idempotencyKey}:${groupEntries[0][0]}`;
      const prior = await findOrderByIdempotencyKey(sampleKey, oxyUserId);
      if (prior) {
        log.general.warn(
          { oxyUserId, idempotencyKey },
          'Concurrent/replayed checkout detected; converging on prior order group',
        );
        return await summarizePriorGroup(oxyUserId, prior.order.checkoutGroupId ?? '');
      }
    }
    throw conflict('Checkout already processed');
  }

  // 8. Best-effort: overwrite the Redis claim with the real group id.
  if (redis && redisKey && holdsRedisClaim) {
    try {
      await withRedisTimeout(
        redis.set(redisKey, checkoutGroupId, 'PX', config.orders.idempotencyTtlMs),
      );
    } catch (err) {
      log.general.warn({ err }, 'Failed to persist checkout idempotency group id to Redis');
    }
  }

  // 9. Empty the cart now that orders exist.
  await clearCart(oxyUserId);

  // 10. Best-effort: notify buyer + seller of each placed order. A notification
  // failure must never fail a completed checkout.
  try {
    for (const o of created) {
      await enqueueOrderEvent({ orderId: o.order.id, event: 'placed' });
    }
  } catch (err) {
    log.general.warn({ err }, 'Failed to enqueue order-placed notifications');
  }

  // 11. Summarize the created orders.
  return { checkoutGroupId, orders: await summarizeOrders(created) };
}

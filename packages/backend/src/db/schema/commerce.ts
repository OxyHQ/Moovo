/**
 * Buyer-facing commerce: saved addresses, the single-currency cart, and the
 * immutable order a checkout produces.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { closedSet, foreignServiceId, moneyMinor } from './columns';
import {
  CURRENCY_CODES,
  ORDER_SELLER_TYPES,
  ORDER_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  SHIPPING_METHODS,
} from './valueSets';
import { listings, productVariants } from './catalog';
import { stores } from './stores';

/**
 * A buyer's saved shipping address, keyed by Oxy user id — no FK, Oxy owns
 * identity.
 *
 * The compound index mirrors `address.ts`'s `{oxyUserId, isDefault:-1,
 * createdAt:-1}`, which is what lets the service resolve "the user's default,
 * or newest" in one indexed read. Promoting a new default (clearing the old
 * one) stays a service-layer concern, same as the source.
 */
export const addresses = pgTable(
  'addresses',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    label: text(),
    recipientName: text().notNull(),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    region: text(),
    postalCode: text().notNull(),
    country: text().notNull(),
    phone: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('addresses_oxy_user_default_created_idx').on(
      table.oxyUserId,
      table.isDefault,
      table.createdAt,
    ),
  ],
);

/**
 * A buyer's single-currency basket, one per Oxy user.
 *
 * Lines live in {@link cartItems} rather than a jsonb array. Neither table
 * stores a price: prices and availability are read LIVE from the variant at
 * view/checkout time, same as the source, so the cart can never serve a stale
 * price. `currency` pins every line to one currency; `cart.service` still owns
 * refusing a variant priced in a different one.
 */
export const carts = pgTable(
  'carts',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    currency: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('carts_oxy_user_id_key').on(table.oxyUserId),
    closedSet('carts_currency_check', table.currency, CURRENCY_CODES),
  ],
);

/**
 * One cart line: a variant reference plus a quantity, never a price.
 *
 * The source's `CartItemSchema` is `{_id:false}` inside an `items` array, so a
 * quantity update there is a read-modify-write over the whole array. As a
 * child table with its own row, `UNIQUE(cartId, variantId)` gives a line real
 * identity and turns "change this line's quantity" into a targeted UPDATE
 * instead of a race between two concurrent requests for the same cart.
 */
export const cartItems = pgTable(
  'cart_items',
  {
    id: generatedId(),
    cartId: text()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * A DELIBERATE BEHAVIOUR CHANGE, recorded rather than left to be found.
     *
     * `catalog-write.service.ts:418` really does hard-delete a variant. Today
     * that leaves the cart line pointing at a dead variant, and because the
     * cart reads prices LIVE the line then fails or drops at hydration. Under
     * this cascade the line simply vanishes from the cart.
     *
     * The cascade is the better behaviour — a cart line whose product no
     * longer exists is not a cart line — but it differs from what production
     * does today, and a behaviour change that is written down is a decision
     * where the same change undocumented is a bug report three months from
     * now.
     */
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    /** `default: Date.now` in the source — when this line was added. */
    addedAt: createdAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('cart_items_cart_variant_key').on(table.cartId, table.variantId),
    // The source has `min: 1` on quantity.
    check('cart_items_quantity_check', sql`${table.quantity} >= 1`),
  ],
);

/**
 * One seller's IMMUTABLE portion of a checkout.
 *
 * A multi-seller cart splits into one order per seller, all sharing a
 * `checkoutGroupId`. Line items live in {@link orderItems} and the status
 * trail in {@link orderStatusEvents} — both are frozen snapshots, never
 * re-derived from live catalog or address state.
 */
export const orders = pgTable(
  'orders',
  {
    id: generatedId(),
    orderNumber: text().notNull(),
    buyerOxyUserId: foreignServiceId().notNull(),
    sellerType: text().notNull(),
    /** Set exactly when `sellerType` is `user`. Oxy owns identity: no FK. */
    sellerOxyUserId: foreignServiceId(),
    /** Set exactly when `sellerType` is `store`. */
    storeId: text().references(() => stores.id, { onDelete: 'restrict' }),

    // `shippingAddressSnapshot`, flattened rather than jsonb: the snapshot is
    // IMMUTABLE once an order is placed — a later edit of the saved `Address`
    // must never change it — and explicit columns make that immutability a
    // property of the schema rather than of nobody happening to write into a
    // jsonb blob.
    shipToLabel: text(),
    shipToRecipientName: text().notNull(),
    shipToLine1: text().notNull(),
    shipToLine2: text(),
    shipToCity: text().notNull(),
    shipToRegion: text(),
    shipToPostalCode: text().notNull(),
    shipToCountry: text().notNull(),
    shipToPhone: text(),

    // `shipping`, flattened.
    shippingMethod: text().notNull(),
    shippingLabel: text().notNull(),
    /**
     * The source stores this Money TWICE — once as `shipping.cost`, once
     * again as `totals.shipping` — and `checkout.service.ts` assigns both
     * from the SAME `cost` variable (`shipping: {..., cost}` and
     * `totals: {..., shipping: cost}`). It is the ONLY writer —
     * `order-hydration.service.ts` merely reads both — so for orders written
     * by today's code one column pair carries both faithfully, and a second
     * pair would be two names for a value that cannot disagree.
     *
     * A census counted orders whose `shipping.cost` and `totals.shipping`
     * disagree in amount or currency: zero. But `orders` held zero rows, so
     * that is an UNVIOLATED result rather than a verified one — it rules out
     * losing data that exists, not the possibility that an older writer could
     * have made the two differ. Were the collection populated by an earlier
     * version, the collapse would drop one value silently: the order still
     * renders, with a plausible number.
     *
     * Re-run the census before cutover. If it is ever non-zero, restore two
     * column pairs — a shape chosen for the code's current shape is the wrong
     * authority when real rows disagree with it.
     */
    shippingCostAmount: moneyMinor().notNull(),
    shippingCostCurrency: text().notNull(),
    trackingNumber: text(),

    // `totals.subtotal` / `totals.grandTotal`. `totals.shipping` is the
    // `shippingCost*` pair above — see the comment there.
    subtotalAmount: moneyMinor().notNull(),
    subtotalCurrency: text().notNull(),
    grandTotalAmount: moneyMinor().notNull(),
    grandTotalCurrency: text().notNull(),

    status: text().notNull().default('pending_payment'),

    // `payment`, flattened.
    paymentStatus: text().notNull().default('unpaid'),
    paymentProvider: text().notNull().default('oxy_pay'),
    paymentReference: text(),
    paidAt: timestamptz(),

    /** Not `required` in the source either — set by checkout, not enforced. */
    checkoutGroupId: text(),
    /**
     * The port of Mongo's `{unique:true, sparse:true}`. A plain unique index
     * would NOT be equivalent: Postgres treats every NULL as DISTINCT for
     * uniqueness, so a plain unique index already tolerates any number of
     * NULLs and looks like sparse-unique by accident. A partial index says
     * the same thing on purpose — "unique among the rows that have one" — and
     * keeps meaning it if that NULL-distinctness behavior ever changes.
     */
    idempotencyKey: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('orders_seller_type_check', table.sellerType, ORDER_SELLER_TYPES),
    closedSet('orders_status_check', table.status, ORDER_STATUSES),
    closedSet('orders_shipping_method_check', table.shippingMethod, SHIPPING_METHODS),
    closedSet('orders_shipping_cost_currency_check', table.shippingCostCurrency, CURRENCY_CODES),
    closedSet('orders_subtotal_currency_check', table.subtotalCurrency, CURRENCY_CODES),
    closedSet('orders_grand_total_currency_check', table.grandTotalCurrency, CURRENCY_CODES),
    closedSet('orders_payment_status_check', table.paymentStatus, PAYMENT_STATUSES),
    closedSet('orders_payment_provider_check', table.paymentProvider, PAYMENT_PROVIDERS),
    /**
     * `order.ts` carries the identical `sellerType:'user'|'store'` +
     * `sellerOxyUserId`/`storeId` shape as `listings`' `ownerType` +
     * `oxyUserId`/`storeId` — but, unlike `listing.ts`, never wrote it as a
     * `pre('validate')` hook; order creation is service-layer only
     * (`checkout.service.ts`). The database can state the same shape
     * `listings_owner_shape_check` does.
     *
     * This is a NEW constraint, added deliberately where the source enforced
     * the invariant in SERVICE CODE ONLY — and `orders` is the one model with
     * this shape that never got a `pre('validate')` hook. Mongoose does not
     * validate on `updateOne`/`findOneAndUpdate` either, so a violating row
     * may exist right now.
     *
     * UNVIOLATED, NOT VERIFIED — and the difference is the point. A census of
     * `moovo-production` (instrument mutation-tested against planted
     * violations first) found zero orders breaking this. But `orders` held
     * ZERO rows, and an empty collection satisfies every predicate: the count
     * says the constraint will not fail on data that does not exist, not that
     * the invariant has ever held under real traffic. It has simply never had
     * data to bite.
     *
     * Re-run the census immediately before the cutover migration applies. A
     * CHECK that was safe against an empty table is not automatically safe
     * against a populated one, and the window between now and cutover is
     * exactly where that changes. See `CONVENTIONS.md` §"Constraints the
     * source never enforced".
     */
    check(
      'orders_seller_shape_check',
      sql`(${table.sellerType} = 'user' and ${table.sellerOxyUserId} is not null and ${table.storeId} is null)
       or (${table.sellerType} = 'store' and ${table.storeId} is not null and ${table.sellerOxyUserId} is null)`,
    ),
    uniqueIndex('orders_order_number_key').on(table.orderNumber),
    uniqueIndex('orders_idempotency_key_key')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('orders_buyer_created_idx').on(table.buyerOxyUserId, table.createdAt),
    index('orders_store_status_created_idx').on(table.storeId, table.status, table.createdAt),
    index('orders_seller_status_created_idx').on(
      table.sellerOxyUserId,
      table.status,
      table.createdAt,
    ),
    index('orders_checkout_group_idx').on(table.checkoutGroupId),
    index('orders_payment_status_created_idx').on(table.paymentStatus, table.createdAt),
    index('orders_status_created_idx').on(table.status, table.createdAt),
  ],
);

/**
 * One IMMUTABLE line-item snapshot of an order, copied from the cart/catalog
 * at checkout time.
 *
 * `listingId`/`variantId` carry NO foreign key on purpose, unlike every other
 * reference in this file: a snapshot has to survive the listing or variant it
 * was bought from later being deleted, and a FK would refuse exactly the
 * delete that must be allowed to happen. `position` is explicit because the
 * source's `OrderItemSchema` is `{_id:false}` inside an array — insertion
 * order was the only identity a line ever had, so the port has to name it
 * rather than rely on physical row order.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    listingId: text().notNull(),
    variantId: text().notNull(),
    title: text().notNull(),
    variantTitle: text().notNull(),
    imageUrl: text(),
    /** `[{name, value}]` — a value object read only with its line. */
    optionValues: jsonb().notNull().default(sql`'[]'::jsonb`),
    unitPriceAmount: moneyMinor().notNull(),
    unitPriceCurrency: text().notNull(),
    quantity: integer().notNull(),
    lineTotalAmount: moneyMinor().notNull(),
    lineTotalCurrency: text().notNull(),
    position: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('order_items_unit_price_currency_check', table.unitPriceCurrency, CURRENCY_CODES),
    closedSet('order_items_line_total_currency_check', table.lineTotalCurrency, CURRENCY_CODES),
    index('order_items_order_position_idx').on(table.orderId, table.position),
  ],
);

/**
 * One entry in an order's `statusHistory` audit trail.
 *
 * Keyed for reading back `(orderId, at, id)` rather than `(orderId, id)`
 * alone: the source's `StatusEventSchema` is also `{_id:false}` inside an
 * array with no other ordering field, so `at` plus the id tiebreaker is the
 * only recoverable read order once the array becomes rows.
 */
export const orderStatusEvents = pgTable(
  'order_status_events',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    status: text().notNull(),
    /** `default: Date.now` in the source. */
    at: createdAt(),
    byOxyUserId: foreignServiceId(),
    note: text(),
  },
  (table) => [
    closedSet('order_status_events_status_check', table.status, ORDER_STATUSES),
    index('order_status_events_order_at_id_idx').on(table.orderId, table.at, table.id),
  ],
);

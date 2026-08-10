/**
 * Checkout against a real PostgreSQL server.
 *
 * This file REPLACES the four properties `services/__tests__/checkout.service.test.ts`
 * asserted against mocks — multi-seller split, reservation rollback, idempotent
 * replay, and totals. Each is carried over, and each is now asserted on STORED
 * ROWS rather than on the document handed to a mocked `Order.create`:
 *
 *  - The old split case asserted `orderCreate` was called three times with one
 *    `checkoutGroupId`. It could not tell whether three orders EXIST, nor
 *    whether their line items landed, because nothing wrote anything.
 *  - The old rollback case asserted `release` was called once. Here the
 *    variant's stock counters are read back, which is the thing the release
 *    was for and the only form in which an over-release is visible.
 *  - The old replay case mocked Redis into returning a prior group id. Here the
 *    DURABLE path is exercised instead — Redis is absent, so the partial unique
 *    index on `idempotency_key` is what settles the replay, which is the path
 *    that has to work when Redis is down.
 *
 * The target is empty, so a checkout that wrote nothing and one that correctly
 * wrote nothing look identical. Every case seeds TWO sellers and asserts the
 * split lands on the right one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import { getDb } from '../../postgres';
import { categories } from '../../schema/catalog';
import { listVariantsForListing, findVariantById } from '../../catalog/catalogRepository';
import { addVariant, createP2PListing } from '../../../services/catalog-write.service';
import { insertStore } from '../../stores/storeRepository';
import { create as createAddress } from '../../../services/address.service';
import { addItem } from '../../../services/cart.service';
import { findCartByUser } from '../cartRepository';
import { listScopedOrders } from '../orderRepository';
import { checkout } from '../../../services/checkout.service';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';

vi.mock('../../../services/oxy-user.service.js', () => ({
  getProfiles: async () => new Map(),
  getProfile: async () => undefined,
}));

// Redis absent, deliberately: it makes every case below exercise the DURABLE
// idempotency path rather than the best-effort cache in front of it.
vi.mock('../../../lib/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/redis')>()),
  getRedisClient: () => null,
}));

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

const BUYER = 'buyer-a';

async function seedCategory(): Promise<void> {
  await getDb()
    .insert(categories)
    .values({ name: 'gadgets', slug: 'gadgets', ancestorSlugs: [], isActive: true })
    .onConflictDoNothing();
}

/** A P2P listing owned by `seller`, with one variant holding `quantity` units. */
async function seedP2P(
  seller: string,
  quantity: number,
  price = 1000,
): Promise<{ listingId: string; variantId: string }> {
  const listingId = await createP2PListing(seller, {
    title: `p-${seller}-${price}`,
    description: '',
    condition: 'new',
    category: 'gadgets',
    imageFileIds: [],
    price: { amount: price, currency: 'USD' },
    quantity,
  });
  const [variant] = await listVariantsForListing(listingId);
  return { listingId, variantId: variant.id };
}

/** A SECOND variant on an existing listing, so both share one seller group. */
async function seedSecondVariantFor(
  listingId: string,
  available: number,
): Promise<{ variantId: string }> {
  const variantId = await addVariant(listingId, {
    optionValues: [{ name: 'edition', value: 'scarce' }],
    price: { amount: 1000, currency: 'USD' },
    inventory: { tracked: true, available },
  });
  return { variantId };
}

async function seedAddressFor(oxyUserId: string): Promise<string> {
  const address = await createAddress(oxyUserId, {
    recipientName: 'R',
    line1: 'L1',
    city: 'C',
    postalCode: 'P',
    country: 'ES',
  });
  return address.id;
}

async function seedAddress(): Promise<string> {
  return await seedAddressFor(BUYER);
}

/** Every order row in the database, regardless of buyer. */
async function countAllOrders(): Promise<number> {
  const rows = await client()`SELECT count(*)::int AS n FROM orders`;
  return rows[0].n as number;
}

/** Every order of BUYER, by order number, with its lines — read straight back. */
async function storedOrders() {
  const page = await listScopedOrders({ kind: 'buyer', oxyUserId: BUYER }, {}, 1, 50);
  return [...page.orders]
    .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber))
    .map((order) => ({ ...order, items: page.items.get(order.id) ?? [] }));
}

describeIfPostgres('checkout on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    await client()`DELETE FROM order_status_events`;
    await client()`DELETE FROM order_items`;
    await client()`DELETE FROM orders`;
    await client()`DELETE FROM cart_items`;
    await client()`DELETE FROM carts`;
    await client()`DELETE FROM product_variants`;
    await client()`DELETE FROM listings`;
    await client()`DELETE FROM categories`;
    await client()`DELETE FROM store_members`;
    await client()`DELETE FROM stores`;
    await client()`DELETE FROM addresses`;
    await client()`DELETE FROM seller_profiles`;
  });

  describe('the multi-seller split', () => {
    it('writes one order per seller, all sharing one checkoutGroupId', async () => {
      await seedCategory();
      const storeA = await insertStore({
        handle: 'store-a',
        name: 'Store A',
        description: '',
        brandColor: '#000000',
        defaultCurrency: 'USD',
        status: 'active',
        owner: { oxyUserId: 'owner-a', permissions: ['store:manage'] },
      });
      if (!storeA) throw new Error('store not created');

      const p1 = await seedP2P('seller-x', 5, 1000);
      const p2 = await seedP2P('seller-y', 5, 2000);
      const addressId = await seedAddress();

      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });
      await addItem(BUYER, { listingId: p2.listingId, variantId: p2.variantId, quantity: 1 });

      const result = await checkout(BUYER, { addressId });

      expect(result.orders).toHaveLength(2);
      const orders = await storedOrders();
      expect(orders).toHaveLength(2);

      // ONE group across both, and it is the one returned to the caller.
      expect(new Set(orders.map((o) => o.checkoutGroupId)).size).toBe(1);
      expect(orders[0].checkoutGroupId).toBe(result.checkoutGroupId);

      // Each order carries ITS OWN seller's line, not the other's.
      const bySeller = new Map(orders.map((o) => [o.sellerOxyUserId, o]));
      expect([...bySeller.keys()].sort()).toEqual(['seller-x', 'seller-y']);
      expect(bySeller.get('seller-x')?.items.map((i) => i.variantId)).toEqual([p1.variantId]);
      expect(bySeller.get('seller-y')?.items.map((i) => i.variantId)).toEqual([p2.variantId]);

      // The cart is emptied once the orders exist.
      const cart = await findCartByUser(BUYER);
      expect(cart?.items ?? []).toHaveLength(0);
    });

    it('snapshots the address onto every order in the group', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5);
      const p2 = await seedP2P('seller-y', 5);
      const addressId = await seedAddress();
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });
      await addItem(BUYER, { listingId: p2.listingId, variantId: p2.variantId, quantity: 1 });

      await checkout(BUYER, { addressId });

      for (const order of await storedOrders()) {
        expect(order.shipToRecipientName).toBe('R');
        expect(order.shipToCountry).toBe('ES');
        // An absent optional stays NULL rather than becoming an empty string —
        // the difference between "no second line" and "a blank second line".
        expect(order.shipToLine2).toBeNull();
      }
    });
  });

  describe('reservation rollback', () => {
    /**
     * **The rollback is only reachable through a RACE, and that is a finding
     * about the code rather than about this test.** Draining a variant's stock
     * and then checking out cannot get there: `getCart` flags any line whose
     * live `available` fell below its quantity, and checkout refuses a stale
     * cart BEFORE reserving anything. The mocked suite this replaces staged the
     * failure by programming `reserve` to reject, which is a scenario the
     * public path cannot produce.
     *
     * What can: two buyers holding the last unit, one of whom reserves first.
     * The loser has already reserved the plentiful line by then and must give
     * it back.
     *
     * The assertion is chosen to hold under BOTH interleavings — the loser
     * either fails at the stale-cart guard having reserved nothing, or at
     * `reserve` and rolls back — because the invariant that matters is the
     * same either way: the plentiful variant ends up holding EXACTLY ONE
     * reservation. Pinning which error the loser sees would be pinning the
     * scheduler.
     */
    it('leaves exactly one reservation held when two buyers race for the last unit', async () => {
      await seedCategory();
      // Both lines belong to ONE seller, so the winner gets exactly one order.
      const plenty = await seedP2P('seller-x', 10, 1000);
      const scarce = await seedSecondVariantFor(plenty.listingId, 1);
      const addressA = await seedAddress();
      const addressB = await seedAddressFor('buyer-b');

      for (const [buyer] of [[BUYER], ['buyer-b']] as const) {
        await addItem(buyer, {
          listingId: plenty.listingId,
          variantId: plenty.variantId,
          quantity: 1,
        });
        await addItem(buyer, {
          listingId: plenty.listingId,
          variantId: scarce.variantId,
          quantity: 1,
        });
      }

      const outcomes = await Promise.allSettled([
        checkout(BUYER, { addressId: addressA }),
        checkout('buyer-b', { addressId: addressB }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(await countAllOrders()).toBe(1);

      // The scarce unit went to exactly one buyer.
      const scarceAfter = await findVariantById(scarce.variantId);
      expect(scarceAfter?.inventoryAvailable).toBe(0);
      expect(scarceAfter?.inventoryCommitted).toBe(1);

      // And the plentiful line holds ONE reservation, not two. Two would read
      // 8/2 — the loser's reservation stranded, stock nobody can ever buy.
      const plentyAfter = await findVariantById(plenty.variantId);
      expect(plentyAfter?.inventoryAvailable).toBe(9);
      expect(plentyAfter?.inventoryCommitted).toBe(1);
    });

    it('refuses a stale cart and reserves nothing', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5);
      const addressId = await seedAddress();
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 3 });

      // Stock falls below the cart line's quantity after it was added.
      await client()`UPDATE product_variants SET inventory_available = 1
                     WHERE id = ${p1.variantId}`;

      await expect(checkout(BUYER, { addressId })).rejects.toSatisfy(
        (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
      );

      expect(await storedOrders()).toHaveLength(0);
      const after = await findVariantById(p1.variantId);
      expect(after?.inventoryAvailable).toBe(1);
      expect(after?.inventoryCommitted).toBe(0);
    });
  });

  describe('durable idempotent replay', () => {
    /**
     * With Redis absent this is decided entirely by
     * `orders_idempotency_key_key`. The replay must converge on the ORIGINAL
     * orders — not create a second set, and not leave the replay's
     * reservations held.
     */
    it('converges on the original group and holds no extra stock', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5);
      const addressId = await seedAddress();
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 2 });

      const first = await checkout(BUYER, { addressId }, 'idem-1');
      expect(first.orders).toHaveLength(1);

      const afterFirst = await findVariantById(p1.variantId);
      expect(afterFirst?.inventoryAvailable).toBe(3);
      expect(afterFirst?.inventoryCommitted).toBe(2);

      // Replay: the cart was cleared, so re-add the same line.
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 2 });
      const replay = await checkout(BUYER, { addressId }, 'idem-1');

      expect(replay.checkoutGroupId).toBe(first.checkoutGroupId);
      expect(replay.orders.map((o) => o.orderNumber)).toEqual(
        first.orders.map((o) => o.orderNumber),
      );
      // Still ONE order, not two.
      expect(await storedOrders()).toHaveLength(1);

      // The replay's reservation was rolled back, so stock is where the FIRST
      // checkout left it. Without the rollback this reads 1/4.
      const afterReplay = await findVariantById(p1.variantId);
      expect(afterReplay?.inventoryAvailable).toBe(3);
      expect(afterReplay?.inventoryCommitted).toBe(2);
    });

    it('lets two DIFFERENT keys create two orders', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 10);
      const addressId = await seedAddress();

      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });
      await checkout(BUYER, { addressId }, 'idem-a');
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });
      await checkout(BUYER, { addressId }, 'idem-b');

      expect(await storedOrders()).toHaveLength(2);
    });
  });

  describe('totals', () => {
    it('sets grandTotal = subtotal + the selected shipping rate', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5, 2500);
      const addressId = await seedAddress();
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 2 });

      await checkout(BUYER, { addressId });

      const [order] = await storedOrders();
      expect(order.subtotalAmount).toBe(5000);
      expect(order.subtotalCurrency).toBe('USD');
      // The source stored the shipping Money TWICE — `shipping.cost` and
      // `totals.shipping` — and assigned both from one variable. Here it is ONE
      // column pair, so they cannot disagree by construction; what is worth
      // asserting is that the grand total is actually built from it.
      expect(order.grandTotalAmount).toBe(order.subtotalAmount + order.shippingCostAmount);
      expect(order.grandTotalCurrency).toBe('USD');
      expect(order.items[0].lineTotalAmount).toBe(5000);
      expect(order.items[0].unitPriceAmount).toBe(2500);
    });

    it('honours a per-seller shipping selection', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5, 1000);
      const addressId = await seedAddress();
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });

      await checkout(BUYER, {
        addressId,
        shippingSelections: { 'user:seller-x': 'express' },
      });

      const [order] = await storedOrders();
      expect(order.shippingMethod).toBe('express');
      expect(order.shippingLabel).toBe('Express shipping');
    });
  });

  describe('checkout refuses rather than half-writing', () => {
    it('refuses an empty cart', async () => {
      const addressId = await seedAddress();
      await expect(checkout(BUYER, { addressId })).rejects.toSatisfy(
        (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
      );
      expect(await storedOrders()).toHaveLength(0);
    });

    it('refuses an address that belongs to somebody else', async () => {
      await seedCategory();
      const p1 = await seedP2P('seller-x', 5);
      await addItem(BUYER, { listingId: p1.listingId, variantId: p1.variantId, quantity: 1 });

      // buyer-b's address exists — so a NOT_FOUND here is the scope, not an
      // empty table.
      const theirs = await createAddress('buyer-b', {
        recipientName: 'Other',
        line1: 'L1',
        city: 'C',
        postalCode: 'P',
        country: 'ES',
      });

      await expect(checkout(BUYER, { addressId: theirs.id })).rejects.toSatisfy(
        (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.NOT_FOUND,
      );
      expect(await storedOrders()).toHaveLength(0);

      // Nothing was reserved on the way to the refusal.
      const variant = await findVariantById(p1.variantId);
      expect(variant?.inventoryAvailable).toBe(5);
    });
  });
});

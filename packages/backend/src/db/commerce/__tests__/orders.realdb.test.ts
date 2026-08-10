/**
 * The order repository against a real PostgreSQL server.
 *
 * The load-bearing case is the COMPARE-AND-SET. `transitionOrderStatus` guards
 * on the current status inside the WHERE clause, and the order service runs
 * inventory commits, restocks and `salesCount` bumps ONLY for the caller whose
 * CAS matched. Move that comparison into JavaScript and every sequential test
 * still passes while the property is gone — a buyer's cancel racing the expire
 * sweep would run the inventory effects twice.
 *
 * So it is asserted by running two transitions concurrently and requiring
 * exactly one to win. That needs two connections, which is precisely what a
 * mocked model does not have.
 *
 * The target is empty, so "returned nothing" and "correctly returned nothing"
 * are the same observation: every scoped read seeds TWO owners and asserts the
 * other's orders are absent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import {
  countStoreOrdersByStatus,
  findOrderById,
  findScopedOrder,
  findStaleUnpaidOrders,
  insertOrder,
  listScopedOrders,
  sumStorePaidRevenue,
  transitionOrderStatus,
  type NewOrder,
} from '../orderRepository';
import { insertStore } from '../../stores/storeRepository';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/**
 * Block until some backend is waiting on a lock for `orderId`, or fail.
 *
 * Polling `pg_stat_activity` rather than sleeping a fixed interval: the point
 * is to establish that the racing statement really is blocked, so a run where
 * it never blocks must FAIL the test rather than proceed and prove nothing.
 */
async function waitForBlockedUpdate(orderId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await client()<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%update%orders%'
    `;
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no blocked UPDATE on orders appeared for ${orderId} — the interleaving this ` +
      'test depends on did not happen, so it would have proved nothing',
  );
}

let orderSeq = 0;

/**
 * A store to hang store-scoped orders off.
 *
 * Through the repository rather than raw SQL: `generatedId()` is an
 * APPLICATION-side default, so a raw `INSERT` into `stores` supplies no id and
 * fails the NOT NULL — the id is not a database default despite reading like
 * one in the schema.
 */
async function seedStore(handle: string): Promise<string> {
  const store = await insertStore({
    handle,
    name: handle,
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'USD',
    status: 'active',
    owner: { oxyUserId: 'store-owner', permissions: ['store:manage'] },
  });
  if (store === null) throw new Error(`seed failed: handle ${handle} taken`);
  return store.id;
}

/** A P2P order from `buyer` to `seller`, with one line. */
async function seedOrder(
  buyer: string,
  seller: string,
  overrides: Partial<NewOrder> = {},
): Promise<string> {
  orderSeq += 1;
  const order = await insertOrder(
    {
      orderNumber: `MRC-${String(orderSeq).padStart(6, '0')}`,
      buyerOxyUserId: buyer,
      sellerType: 'user',
      sellerOxyUserId: seller,
      shipToRecipientName: 'R',
      shipToLine1: 'L1',
      shipToCity: 'C',
      shipToPostalCode: 'P',
      shipToCountry: 'ES',
      shippingMethod: 'standard',
      shippingLabel: 'Standard',
      shippingCostAmount: 0,
      shippingCostCurrency: 'USD',
      subtotalAmount: 1000,
      subtotalCurrency: 'USD',
      grandTotalAmount: 1000,
      grandTotalCurrency: 'USD',
      ...overrides,
    },
    [
      {
        listingId: 'listing-1',
        variantId: 'variant-1',
        title: 'T',
        variantTitle: 'V',
        optionValues: [],
        unitPriceAmount: 1000,
        unitPriceCurrency: 'USD',
        quantity: 1,
        lineTotalAmount: 1000,
        lineTotalCurrency: 'USD',
        position: 0,
      },
    ],
  );
  // `insertOrder` answers null when an `idempotencyKey` is already taken. No
  // seed here sets one, so a null is a broken fixture rather than a duplicate —
  // failing loudly beats returning an id from a row that was never written.
  if (order === null) throw new Error('seed failed: insertOrder returned null');
  return order.id;
}

describeIfPostgres('the order repository on a real server', () => {
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
    await client()`DELETE FROM store_members`;
    await client()`DELETE FROM stores`;
  });

  describe('the status transition is a compare-and-set', () => {
    /**
     * The property the whole file exists for, asserted DETERMINISTICALLY.
     *
     * Two `transitionOrderStatus` calls fired with `Promise.all` do NOT
     * discriminate — measured: with the guard moved into JavaScript that test
     * still passed 15/15, because the two transactions did not overlap and the
     * second simply read the first's committed status. A concurrency test that
     * depends on scheduling is a test that reports "safe" when it happened not
     * to race.
     *
     * So the interleaving is FORCED. The test holds the order row with
     * `SELECT ... FOR UPDATE`, lets the transition reach its UPDATE and block,
     * changes the status underneath it, then commits:
     *
     *  - guard in the WHERE clause → the UPDATE re-evaluates against the new
     *    row version under READ COMMITTED, matches nothing, returns null;
     *  - guard in JavaScript → the status was read BEFORE the block, the
     *    UPDATE keys on the id alone, and it overwrites a decision that was
     *    already made.
     *
     * The second is the real hazard: the order service would then run the
     * inventory effects for a transition the database had already superseded.
     */
    it('loses when the status changes between its read and its write', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');

      let racing: Promise<unknown> | null = null;

      await client().begin(async (tx) => {
        // Hold the row. Any UPDATE against it now blocks until this commits.
        await tx`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;

        racing = transitionOrderStatus(
          orderId,
          'pending_payment',
          'cancelled',
          {},
          { status: 'cancelled' },
        );

        // Wait until it is genuinely BLOCKED rather than sleeping a guess. If
        // the block never appears the test fails here instead of silently
        // measuring nothing — the precondition is asserted, not assumed.
        await waitForBlockedUpdate(orderId);

        // Supersede it while it waits.
        await tx`UPDATE orders SET status = 'paid' WHERE id = ${orderId}`;
      });

      // The transition's UPDATE now unblocks and re-evaluates its WHERE.
      expect(await racing).toBeNull();

      const record = await findOrderById(orderId);
      expect(record?.order.status).toBe('paid');
      // The superseded transition appended no status event either.
      expect(record?.statusHistory).toEqual([]);
    });

    it('returns null when the order is not at the expected status', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      await transitionOrderStatus(orderId, 'pending_payment', 'paid', {}, { status: 'paid' });

      const late = await transitionOrderStatus(
        orderId,
        'pending_payment',
        'cancelled',
        {},
        { status: 'cancelled' },
      );

      expect(late).toBeNull();
      // The refused transition appended no event either.
      expect((await findOrderById(orderId))?.statusHistory).toHaveLength(1);
      expect((await findOrderById(orderId))?.order.status).toBe('paid');
    });

    it('applies the payment patch and records the actor and note', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      const paidAt = new Date('2026-08-10T10:00:00.000Z');

      await transitionOrderStatus(
        orderId,
        'pending_payment',
        'paid',
        { paymentStatus: 'paid', paidAt },
        { status: 'paid', byOxyUserId: 'buyer-a', note: 'mock-pay' },
      );

      const record = await findOrderById(orderId);
      expect(record?.order.paymentStatus).toBe('paid');
      expect(record?.order.paidAt).toEqual(paidAt);
      expect(record?.statusHistory[0].byOxyUserId).toBe('buyer-a');
      expect(record?.statusHistory[0].note).toBe('mock-pay');
    });

    it('refuses a status outside the closed set', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      await expect(
        transitionOrderStatus(orderId, 'pending_payment', 'teleported', {}, { status: 'paid' }),
      ).rejects.toThrow();
    });
  });

  describe('scoped reads never cross an owner boundary', () => {
    it('returns the buyer\'s own orders and not another buyer\'s', async () => {
      await seedOrder('buyer-a', 'seller-a');
      await seedOrder('buyer-b', 'seller-a');

      const page = await listScopedOrders({ kind: 'buyer', oxyUserId: 'buyer-a' }, {}, 1, 10);

      expect(page.total).toBe(1);
      expect(page.orders[0].buyerOxyUserId).toBe('buyer-a');
      expect(page.orders.some((o) => o.buyerOxyUserId === 'buyer-b')).toBe(false);
    });

    it('returns both when both are asked for (positive control)', async () => {
      await seedOrder('buyer-a', 'seller-a');
      await seedOrder('buyer-a', 'seller-b');

      // Proves the single result above was a filter working, not a reader that
      // can only ever find one row.
      expect((await listScopedOrders({ kind: 'buyer', oxyUserId: 'buyer-a' }, {}, 1, 10)).total).toBe(2);
    });

    it('does not let a buyer read an order by id that is not theirs', async () => {
      const theirs = await seedOrder('buyer-b', 'seller-a');

      expect(await findScopedOrder(theirs, { kind: 'buyer', oxyUserId: 'buyer-a' })).toBeNull();
      expect(await findScopedOrder(theirs, { kind: 'buyer', oxyUserId: 'buyer-b' })).not.toBeNull();
    });

    it('scopes a seller by sellerType as well as id', async () => {
      // A store order carrying the same id in `sellerOxyUserId` must NOT be
      // reachable through the seller scope — that is what stating
      // `sellerType = 'user'` alongside the id buys.
      const storeId = await seedStore('s1');
      await seedOrder('buyer-a', 'seller-a');
      await seedOrder('buyer-a', 'unused', {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId,
      });

      const asSeller = await listScopedOrders({ kind: 'seller', oxyUserId: 'seller-a' }, {}, 1, 10);
      const asStore = await listScopedOrders({ kind: 'store', storeId }, {}, 1, 10);

      expect(asSeller.total).toBe(1);
      expect(asSeller.orders[0].sellerType).toBe('user');
      expect(asStore.total).toBe(1);
      expect(asStore.orders[0].sellerType).toBe('store');
    });

    it('filters by status without losing the owner scope', async () => {
      const mine = await seedOrder('buyer-a', 'seller-a');
      await seedOrder('buyer-b', 'seller-a');
      await transitionOrderStatus(mine, 'pending_payment', 'paid', {}, { status: 'paid' });

      const paid = await listScopedOrders(
        { kind: 'seller', oxyUserId: 'seller-a' },
        { status: 'paid' },
        1,
        10,
      );

      expect(paid.total).toBe(1);
      expect(paid.orders[0].id).toBe(mine);
    });
  });

  describe('the seller-shape CHECK the source enforced only in service code', () => {
    it('refuses a user-sold order that also names a store', async () => {
      await expect(
        client()`
          INSERT INTO orders (order_number, buyer_oxy_user_id, seller_type, seller_oxy_user_id,
            store_id, ship_to_recipient_name, ship_to_line1, ship_to_city, ship_to_postal_code,
            ship_to_country, shipping_method, shipping_label, shipping_cost_amount,
            shipping_cost_currency, subtotal_amount, subtotal_currency, grand_total_amount,
            grand_total_currency)
          VALUES ('MRC-BAD01', 'b', 'user', 's', '00000000-0000-0000-0000-000000000001',
            'R', 'L', 'C', 'P', 'ES', 'standard', 'Standard', 0, 'USD', 1, 'USD', 1, 'USD')
        `,
      ).rejects.toThrow();
    });

    it('refuses an UPDATE that clears the seller', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      await expect(
        client()`UPDATE orders SET seller_oxy_user_id = NULL WHERE id = ${orderId}`,
      ).rejects.toThrow();
    });
  });

  describe('items and history come back in a deterministic order', () => {
    it('orders the status trail oldest first', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      await transitionOrderStatus(orderId, 'pending_payment', 'paid', {}, { status: 'paid' });
      await transitionOrderStatus(orderId, 'paid', 'processing', {}, { status: 'processing' });
      await transitionOrderStatus(orderId, 'processing', 'shipped', {}, { status: 'shipped' });

      const record = await findOrderById(orderId);
      expect(record?.statusHistory.map((e) => e.status)).toEqual(['paid', 'processing', 'shipped']);
    });

    it('carries the order lines', async () => {
      const orderId = await seedOrder('buyer-a', 'seller-a');
      const record = await findOrderById(orderId);
      expect(record?.items).toHaveLength(1);
      expect(record?.items[0].variantId).toBe('variant-1');
    });
  });

  describe('store dashboard aggregates', () => {
    it('counts orders per status and sums only PAID revenue', async () => {
      const storeId = await seedStore('s2');
      const paid = await seedOrder('buyer-a', 'unused', {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId,
        grandTotalAmount: 2500,
      });
      await seedOrder('buyer-b', 'unused', {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId,
        grandTotalAmount: 9999,
      });
      await transitionOrderStatus(
        paid,
        'pending_payment',
        'paid',
        { paymentStatus: 'paid' },
        { status: 'paid' },
      );

      const counts = await countStoreOrdersByStatus(storeId);
      expect(counts.get('paid')).toBe(1);
      expect(counts.get('pending_payment')).toBe(1);

      const revenue = await sumStorePaidRevenue(storeId);
      // 9999 is unpaid and must NOT be included — the half that fails if the
      // payment predicate is dropped.
      expect(revenue.get('USD')).toBe(2500);
      // A number, not a string: an uncast sum reaches JS as "2500" through
      // postgres.js while tsc still types it `number`.
      expect(typeof revenue.get('USD')).toBe('number');
    });
  });

  describe('the stale-unpaid sweep', () => {
    it('returns only orders older than the cutoff that are still unpaid', async () => {
      const stale = await seedOrder('buyer-a', 'seller-a');
      const fresh = await seedOrder('buyer-b', 'seller-a');
      const paidOld = await seedOrder('buyer-c', 'seller-a');
      await transitionOrderStatus(paidOld, 'pending_payment', 'paid', {}, { status: 'paid' });

      // Age two of them past the cutoff; `fresh` stays recent.
      await client()`UPDATE orders SET created_at = now() - interval '2 hours'
                     WHERE id in (${stale}, ${paidOld})`;

      const found = await findStaleUnpaidOrders(new Date(Date.now() - 60 * 60 * 1000));

      expect(found.map((r) => r.order.id)).toEqual([stale]);
      expect(found.some((r) => r.order.id === fresh)).toBe(false);
      expect(found.some((r) => r.order.id === paidOld)).toBe(false);
      // The sweep releases stock per line, so the lines must travel with it.
      expect(found[0].items).toHaveLength(1);
    });
  });
});

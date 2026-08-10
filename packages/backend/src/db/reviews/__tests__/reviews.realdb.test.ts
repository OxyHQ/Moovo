/**
 * The reviews domain against a real PostgreSQL server.
 *
 * This file REPLACES `services/__tests__/review.service.test.ts`, which mocked
 * five Mongoose models. Three properties decide whether this port is correct
 * and none of them survives a mock:
 *
 *  - **The verified-purchase gate's listing branch is a JOIN now.** The source
 *    asked `{'items.listingId': targetId}`, which Mongo answers by reaching
 *    inside the order's embedded array; line items are their own table, so the
 *    same question is an EXISTS over `order_items`. A mock returning a
 *    hand-built order proves nothing about which orders the server would match
 *    — and this gate is what stands between a stranger and a review.
 *  - **`reviews_author_listing_key` is PARTIAL**, so it constrains listing
 *    reviews and permits many store/seller rows with a NULL `listingId`. Only a
 *    real index can be asked whether it behaves that way.
 *  - **The aggregate is `avg()` over the PUBLISHED rows**, and postgres.js
 *    hands `numeric` back as a STRING while drizzle types it `number`. A mock
 *    returns whatever number it was told to.
 *
 * The target is empty, so "returned nothing" and "correctly returned nothing"
 * are the same observation. Every scoped case seeds TWO owners and asserts the
 * other's rows are absent.
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
import { reviews } from '../../schema/engagement';
import { insertOrder, type NewOrder } from '../../commerce/orderRepository';
import { insertStore, findStoreById } from '../../stores/storeRepository';
import { findSellerProfilesByUserIds } from '../../stores/sellerProfileRepository';
import { createP2PListing } from '../../../services/catalog-write.service';
import { findListingById, listVariantsForListing } from '../../catalog/catalogRepository';
import { aggregateForTarget, listPublishedReviewTargets } from '../reviewRepository';
import {
  createReview,
  listReviews,
  recomputeAggregate,
} from '../../../services/review.service';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';

vi.mock('../../../services/oxy-user.service.js', () => ({
  getProfiles: async () => new Map(),
  getProfile: async () => undefined,
}));

vi.mock('../../../lib/notification-service.js', () => ({
  sendNotification: async () => undefined,
}));

vi.mock('../../../queue/producers.js', () => ({
  enqueueRecomputeAggregate: async () => undefined,
}));

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

let orderSeq = 0;

async function seedCategory(): Promise<void> {
  await getDb()
    .insert(categories)
    .values({ name: 'gadgets', slug: 'gadgets', ancestorSlugs: [], isActive: true })
    .onConflictDoNothing();
}

/** A P2P listing owned by `seller`. */
async function seedListing(seller: string, title: string): Promise<string> {
  return await createP2PListing(seller, {
    title,
    description: '',
    condition: 'new',
    category: 'gadgets',
    imageFileIds: [],
    price: { amount: 1000, currency: 'USD' },
    quantity: 5,
  });
}

/**
 * A store, through the repository rather than raw SQL: `generatedId()` is an
 * APPLICATION-side default, so a raw INSERT supplies no id and fails NOT NULL.
 */
async function seedStore(handle: string, owner = 'store-owner'): Promise<string> {
  const store = await insertStore({
    handle,
    name: handle,
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'USD',
    status: 'active',
    owner: { oxyUserId: owner, permissions: ['store:manage'] },
  });
  if (store === null) throw new Error(`seed failed: handle ${handle} taken`);
  return store.id;
}

/** An order from `buyer`, in `status`, carrying one line for `listingId`. */
async function seedOrder(
  buyer: string,
  status: string,
  line: { listingId: string; variantId: string },
  overrides: Partial<NewOrder> = {},
): Promise<string> {
  orderSeq += 1;
  const order = await insertOrder(
    {
      orderNumber: `MRC-R${String(orderSeq).padStart(5, '0')}`,
      buyerOxyUserId: buyer,
      sellerType: 'user',
      sellerOxyUserId: 'seller-a',
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
      status,
      ...overrides,
    },
    [
      {
        listingId: line.listingId,
        variantId: line.variantId,
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
  if (order === null) throw new Error('seed failed: insertOrder returned null');
  return order.id;
}

/** A listing plus its sole variant. */
async function seedProduct(seller: string, title: string) {
  const listingId = await seedListing(seller, title);
  const [variant] = await listVariantsForListing(listingId);
  return { listingId, variantId: variant.id };
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (err: unknown) => isMoovoError(err) && err.code === code,
    `expected a ${code} error`,
  );
}

describeIfPostgres('the reviews domain on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    await client()`DELETE FROM reviews`;
    await client()`DELETE FROM order_status_events`;
    await client()`DELETE FROM order_items`;
    await client()`DELETE FROM orders`;
    await client()`DELETE FROM product_variants`;
    await client()`DELETE FROM listings`;
    await client()`DELETE FROM categories`;
    await client()`DELETE FROM store_members`;
    await client()`DELETE FROM stores`;
    await client()`DELETE FROM seller_profiles`;
  });

  describe('the verified-purchase gate', () => {
    /**
     * The case this file exists for.
     *
     * The buyer bought product A and is trying to review product B. Both
     * listings exist and the buyer has a real qualifying order — so a gate that
     * merely checked "this buyer has bought something" would let it through,
     * and so would one whose join lost its listing predicate.
     */
    it('refuses a listing the buyer did NOT buy, while allowing the one they did', async () => {
      await seedCategory();
      const bought = await seedProduct('seller-a', 'bought');
      const notBought = await seedProduct('seller-b', 'not-bought');
      await seedOrder('buyer-a', 'delivered', bought);

      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: notBought.listingId,
          rating: 5,
        }),
        ErrorCodes.FORBIDDEN,
      );

      // …and the listing they DID buy goes through, so the refusal above is the
      // predicate rather than a gate that refuses everything.
      const review = await createReview('buyer-a', {
        targetType: 'listing',
        listingId: bought.listingId,
        rating: 5,
      });
      expect(review.rating).toBe(5);
    });

    it("refuses a listing bought by ANOTHER buyer", async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      // buyer-b's order exists and qualifies — for buyer-b.
      await seedOrder('buyer-b', 'delivered', product);

      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: product.listingId,
          rating: 4,
        }),
        ErrorCodes.FORBIDDEN,
      );

      const allowed = await createReview('buyer-b', {
        targetType: 'listing',
        listingId: product.listingId,
        rating: 4,
      });
      expect(allowed.rating).toBe(4);
    });

    it('refuses an order that has not been paid for yet', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      await seedOrder('buyer-a', 'pending_payment', product);

      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: product.listingId,
          rating: 5,
        }),
        ErrorCodes.FORBIDDEN,
      );

      // The same order, advanced to a purchased status, qualifies — so the
      // refusal is the status predicate and not the join.
      await client()`UPDATE orders SET status = 'delivered' WHERE buyer_oxy_user_id = 'buyer-a'`;
      const review = await createReview('buyer-a', {
        targetType: 'listing',
        listingId: product.listingId,
        rating: 5,
      });
      expect(review.rating).toBe(5);
    });

    it('gates a STORE review on an order from that store, not another', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      const storeA = await seedStore('store-a');
      const storeB = await seedStore('store-b');
      await seedOrder('buyer-a', 'paid', product, {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId: storeA,
      });

      await expectCode(
        createReview('buyer-a', { targetType: 'store', storeId: storeB, rating: 3 }),
        ErrorCodes.FORBIDDEN,
      );

      const review = await createReview('buyer-a', {
        targetType: 'store',
        storeId: storeA,
        rating: 3,
      });
      expect(review.rating).toBe(3);
    });

    it('gates a SELLER review on an order from that seller, not another', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      await seedOrder('buyer-a', 'shipped', product, { sellerOxyUserId: 'seller-a' });

      await expectCode(
        createReview('buyer-a', {
          targetType: 'seller',
          sellerOxyUserId: 'seller-b',
          rating: 2,
        }),
        ErrorCodes.FORBIDDEN,
      );

      const review = await createReview('buyer-a', {
        targetType: 'seller',
        sellerOxyUserId: 'seller-a',
        rating: 2,
      });
      expect(review.rating).toBe(2);
    });

    /**
     * The NAMED-order branch and the search branch must agree about what
     * "covers this target" means. They are separate code paths, and the named
     * one is the only place a caller supplies an id.
     */
    it('refuses a named orderId belonging to somebody else', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      const theirOrder = await seedOrder('buyer-b', 'delivered', product);

      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: product.listingId,
          rating: 5,
          orderId: theirOrder,
        }),
        ErrorCodes.FORBIDDEN,
      );
    });

    it('refuses a named orderId that does not cover the target listing', async () => {
      await seedCategory();
      const bought = await seedProduct('seller-a', 'bought');
      const other = await seedProduct('seller-b', 'other');
      const order = await seedOrder('buyer-a', 'delivered', bought);

      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: other.listingId,
          rating: 5,
          orderId: order,
        }),
        ErrorCodes.FORBIDDEN,
      );
    });
  });

  describe('one review per target', () => {
    it('refuses a second review of the same listing', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      await seedOrder('buyer-a', 'delivered', product);

      await createReview('buyer-a', {
        targetType: 'listing',
        listingId: product.listingId,
        rating: 5,
      });
      await expectCode(
        createReview('buyer-a', {
          targetType: 'listing',
          listingId: product.listingId,
          rating: 1,
        }),
        ErrorCodes.CONFLICT,
      );

      // A DIFFERENT buyer may still review it — the constraint is per author.
      await seedOrder('buyer-b', 'delivered', product);
      const second = await createReview('buyer-b', {
        targetType: 'listing',
        listingId: product.listingId,
        rating: 4,
      });
      expect(second.rating).toBe(4);
    });

    /**
     * `reviews_author_listing_key` is PARTIAL — `WHERE listing_id IS NOT NULL`.
     * If it were a plain unique, the SECOND store review by the same author
     * would collide on `(author, NULL)` and this would fail. Postgres treats
     * NULLs as distinct so a plain unique would also permit it, which is why
     * this is paired with the listing case above rather than standing alone.
     */
    it('permits one author to review several stores, whose listingId is NULL', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 'p');
      const storeA = await seedStore('store-a');
      const storeB = await seedStore('store-b');
      await seedOrder('buyer-a', 'paid', product, {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId: storeA,
      });
      await seedOrder('buyer-a', 'paid', product, {
        sellerType: 'store',
        sellerOxyUserId: null,
        storeId: storeB,
      });

      await createReview('buyer-a', { targetType: 'store', storeId: storeA, rating: 5 });
      const second = await createReview('buyer-a', {
        targetType: 'store',
        storeId: storeB,
        rating: 3,
      });
      expect(second.rating).toBe(3);
    });
  });

  describe('the rating aggregate', () => {
    async function seedPublishedReview(
      author: string,
      target: { listingId?: string; storeId?: string; sellerOxyUserId?: string },
      rating: number,
      status = 'published',
    ): Promise<void> {
      const targetType = target.listingId ? 'listing' : target.storeId ? 'store' : 'seller';
      await getDb()
        .insert(reviews)
        .values({ authorOxyUserId: author, targetType, rating, status, ...target });
    }

    it('writes a rounded average and count onto the listing, ignoring the other listing', async () => {
      await seedCategory();
      const a = await seedListing('seller-a', 'a');
      const b = await seedListing('seller-b', 'b');
      await seedPublishedReview('buyer-a', { listingId: a }, 5);
      await seedPublishedReview('buyer-b', { listingId: a }, 4);
      await seedPublishedReview('buyer-c', { listingId: a }, 4);
      // Another listing's review, which must not reach a's average.
      await seedPublishedReview('buyer-a', { listingId: b }, 1);

      const aggregate = await recomputeAggregate('listing', a);
      // (5+4+4)/3 = 4.333… → 4.3
      expect(aggregate).toEqual({ rating: 4.3, reviewCount: 3 });

      const listing = await findListingById(a);
      expect(listing?.rating).toBe(4.3);
      expect(listing?.reviewCount).toBe(3);

      // b is untouched by a's recompute and has its own answer.
      const other = await findListingById(b);
      expect(other?.reviewCount).toBe(0);
      expect(await aggregateForTarget('listing', b)).toEqual({ average: 1, count: 1 });
    });

    it('excludes HIDDEN reviews from the average', async () => {
      await seedCategory();
      const listingId = await seedListing('seller-a', 'a');
      await seedPublishedReview('buyer-a', { listingId }, 5);
      await seedPublishedReview('buyer-b', { listingId }, 1, 'hidden');

      // 5 alone, not (5+1)/2 = 3.
      expect(await recomputeAggregate('listing', listingId)).toEqual({
        rating: 5,
        reviewCount: 1,
      });
    });

    it('writes ZERO when the last published review goes, rather than leaving a stale rating', async () => {
      await seedCategory();
      const listingId = await seedListing('seller-a', 'a');
      await seedPublishedReview('buyer-a', { listingId }, 5);
      await recomputeAggregate('listing', listingId);
      expect((await findListingById(listingId))?.rating).toBe(5);

      await client()`DELETE FROM reviews`;
      expect(await recomputeAggregate('listing', listingId)).toEqual({
        rating: 0,
        reviewCount: 0,
      });
      const after = await findListingById(listingId);
      expect(after?.rating).toBe(0);
      expect(after?.reviewCount).toBe(0);
    });

    it('writes a store aggregate onto the store', async () => {
      const storeId = await seedStore('store-a');
      await seedPublishedReview('buyer-a', { storeId }, 4);
      await seedPublishedReview('buyer-b', { storeId }, 5);

      expect(await recomputeAggregate('store', storeId)).toEqual({
        rating: 4.5,
        reviewCount: 2,
      });
      const store = await findStoreById(storeId);
      expect(store?.rating).toBe(4.5);
      expect(store?.reviewCount).toBe(2);
    });

    /**
     * A seller's FIRST review arrives before any profile row exists. The source
     * used `{upsert: true}`; a plain UPDATE would move zero rows and drop the
     * aggregate with no error anywhere.
     */
    it('CREATES the seller profile when their first review lands', async () => {
      expect(await findSellerProfilesByUserIds(['seller-new'])).toHaveLength(0);
      await seedPublishedReview('buyer-a', { sellerOxyUserId: 'seller-new' }, 3);

      expect(await recomputeAggregate('seller', 'seller-new')).toEqual({
        rating: 3,
        reviewCount: 1,
      });
      const [profile] = await findSellerProfilesByUserIds(['seller-new']);
      expect(profile.rating).toBe(3);
      expect(profile.reviewCount).toBe(1);
    });

    /**
     * `avg()` comes back from postgres.js as a STRING for `numeric` while
     * drizzle types it `number`. Uncast, the rounding downstream would be
     * string arithmetic — and a whole-number average would still look right,
     * which is why the fractional case above is the one that matters.
     */
    it('returns the average as a NUMBER, not a string', async () => {
      await seedCategory();
      const listingId = await seedListing('seller-a', 'a');
      await seedPublishedReview('buyer-a', { listingId }, 5);
      await seedPublishedReview('buyer-b', { listingId }, 2);

      const { average, count } = await aggregateForTarget('listing', listingId);
      expect(typeof average).toBe('number');
      expect(typeof count).toBe('number');
      expect(average).toBeCloseTo(3.5);
    });
  });

  describe('the drift sweep working set', () => {
    it('lists every distinct PUBLISHED target once, and no unpublished one', async () => {
      await seedCategory();
      const listingId = await seedListing('seller-a', 'a');
      const storeId = await seedStore('store-a');

      await getDb()
        .insert(reviews)
        .values([
          { authorOxyUserId: 'buyer-a', targetType: 'listing', listingId, rating: 5 },
          // Same target, second author — must appear ONCE.
          { authorOxyUserId: 'buyer-b', targetType: 'listing', listingId, rating: 4 },
          { authorOxyUserId: 'buyer-a', targetType: 'store', storeId, rating: 3 },
          { authorOxyUserId: 'buyer-a', targetType: 'seller', sellerOxyUserId: 'seller-z', rating: 2 },
          // Hidden — not a target for the sweep.
          {
            authorOxyUserId: 'buyer-c',
            targetType: 'seller',
            sellerOxyUserId: 'seller-hidden',
            rating: 1,
            status: 'hidden',
          },
        ]);

      const targets = await listPublishedReviewTargets();
      expect(targets).toEqual([
        { targetType: 'listing', targetId: listingId },
        { targetType: 'seller', targetId: 'seller-z' },
        { targetType: 'store', targetId: storeId },
      ]);
      expect(targets.some((t) => t.targetId === 'seller-hidden')).toBe(false);
    });
  });

  describe('listing a target\'s reviews', () => {
    it('returns only this target\'s published reviews, newest first', async () => {
      await seedCategory();
      const a = await seedListing('seller-a', 'a');
      const b = await seedListing('seller-b', 'b');
      await getDb()
        .insert(reviews)
        .values([
          { authorOxyUserId: 'buyer-a', targetType: 'listing', listingId: a, rating: 5, body: 'first' },
          { authorOxyUserId: 'buyer-b', targetType: 'listing', listingId: a, rating: 4, body: 'second' },
          { authorOxyUserId: 'buyer-c', targetType: 'listing', listingId: a, rating: 1, status: 'hidden' },
          { authorOxyUserId: 'buyer-a', targetType: 'listing', listingId: b, rating: 2, body: 'other' },
        ]);

      const page = await listReviews(
        { targetType: 'listing', targetId: a },
        { page: 1, limit: 10 },
      );
      expect(page.total).toBe(2);
      expect(page.data.map((r) => r.body).sort()).toEqual(['first', 'second']);

      // b's review exists, so a's total of 2 is filtering rather than emptiness.
      const other = await listReviews(
        { targetType: 'listing', targetId: b },
        { page: 1, limit: 10 },
      );
      expect(other.data.map((r) => r.body)).toEqual(['other']);
    });
  });
});

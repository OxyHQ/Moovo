/**
 * The catalogue WRITE paths against a real PostgreSQL server.
 *
 * This file REPLACES `services/__tests__/inventory.service.test.ts`, which
 * mocked the Mongoose model and asserted the exact filter and `$inc` document
 * handed to it. That was the only option while no test server existed; it is
 * both impossible and wrong now, and the reason is the point of the port:
 *
 *  - **The reserve guard is a compare-and-set in the WHERE clause.** A mock
 *    that records the filter proves the filter was WRITTEN, never that the
 *    server enforces it. The race is asserted here by running two reserves
 *    concurrently against one row and requiring exactly one to win — which no
 *    mock can express, because a mock has no second connection.
 *  - **CHECK constraints refuse writes a mock accepts.** `listings_owner_shape_check`
 *    replaces the `pre('validate')` hook, and unlike the hook it also covers
 *    UPDATEs. Only a real server can refuse them.
 *
 * **The target is empty, so "wrote nothing" and "correctly wrote nothing" are
 * the same observation.** Every scoped case therefore seeds TWO owners and
 * asserts the other owner's row was not touched.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import { getDb } from '../../postgres';
import { categories } from '../../schema/catalog';
import { findListingById, findVariantById, listVariantsForListing } from '../catalogRepository';
import {
  archiveListing,
  createP2PListing,
  removeVariant,
  syncListingFacets,
  updateListing,
} from '../../../services/catalog-write.service';
import { commit, release, reserve, restock, setAvailable } from '../../../services/inventory.service';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** The category every P2P listing below is created under. */
async function seedCategory(slug = 'gadgets'): Promise<void> {
  await getDb()
    .insert(categories)
    .values({ name: slug, slug, ancestorSlugs: [], isActive: true })
    .onConflictDoNothing();
}

/** Create a P2P listing owned by `owner` with one variant holding `quantity`. */
async function seedP2P(owner: string, quantity: number, price = 1000): Promise<string> {
  return await createP2PListing(owner, {
    title: `listing-${owner}`,
    description: '',
    condition: 'new',
    category: 'gadgets',
    imageFileIds: [],
    price: { amount: price, currency: 'USD' },
    quantity,
  });
}

/** The single variant of a P2P listing. */
async function soleVariant(listingId: string) {
  const [variant] = await listVariantsForListing(listingId);
  if (!variant) throw new Error(`listing ${listingId} has no variant`);
  return variant;
}

/** Assert an error carries a specific Moovo error code. */
async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (err: unknown) => isMoovoError(err) && err.code === code,
    `expected a ${code} error`,
  );
}

describeIfPostgres('the catalogue write paths on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    await client()`DELETE FROM product_variants`;
    await client()`DELETE FROM listings`;
    await client()`DELETE FROM categories`;
    await client()`DELETE FROM seller_profiles`;
  });

  describe('creating a P2P listing', () => {
    it('creates the listing and its single default variant, with facets synced', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 3, 2500);

      const listing = await findListingById(listingId);
      expect(listing).not.toBeNull();
      expect(listing?.ownerType).toBe('user');
      expect(listing?.oxyUserId).toBe('seller-a');
      // The owner CHECK's other half: a user-owned listing carries no store.
      expect(listing?.storeId).toBeNull();
      expect(listing?.variantCount).toBe(1);
      expect(listing?.hasInventory).toBe(true);
      expect(listing?.priceMinAmount).toBe(2500);
      expect(listing?.priceMinCurrency).toBe('USD');

      const variant = await soleVariant(listingId);
      expect(variant.inventoryAvailable).toBe(3);
      expect(variant.inventoryCommitted).toBe(0);
    });

    it('refuses a listing whose category does not exist', async () => {
      await expectCode(seedP2P('seller-a', 1), ErrorCodes.NOT_FOUND);
    });
  });

  describe('the owner-shape CHECK replaces the pre(validate) hook', () => {
    /**
     * The hook ran on `create`/`save` and NOT on `updateOne`, so the source
     * could break this invariant through an update. These two cases are the
     * reason the constraint exists rather than a re-implemented guard.
     */
    it('refuses a user-owned listing that also names a store', async () => {
      await seedCategory();
      await expect(
        client()`
          INSERT INTO listings (owner_type, oxy_user_id, store_id, title, description, condition, status)
          VALUES ('user', 'seller-a', '00000000-0000-0000-0000-000000000001', 't', '', 'new', 'active')
        `,
      ).rejects.toThrow();
    });

    it('refuses a user-owned listing with NO owner id at all', async () => {
      await seedCategory();
      await expect(
        client()`
          INSERT INTO listings (owner_type, title, description, condition, status)
          VALUES ('user', 't', '', 'new', 'active')
        `,
      ).rejects.toThrow();
    });

    it('refuses an UPDATE that clears the owner — the case the hook never saw', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      await expect(
        client()`UPDATE listings SET oxy_user_id = NULL WHERE id = ${listingId}`,
      ).rejects.toThrow();
    });
  });

  describe('reserve is a compare-and-set, not a read-then-write', () => {
    it('decrements available and raises committed', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 5);
      const variant = await soleVariant(listingId);

      await reserve(variant.id, 2);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(3);
      expect(after?.inventoryCommitted).toBe(2);
    });

    it('throws OUT_OF_STOCK when the guard fails, and writes nothing', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const variant = await soleVariant(listingId);

      await expectCode(reserve(variant.id, 2), ErrorCodes.OUT_OF_STOCK);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(1);
      expect(after?.inventoryCommitted).toBe(0);
    });

    /**
     * The property the mocked suite could not express.
     *
     * Two callers reserve the last unit at once. With the guard in the WHERE
     * clause exactly one matches a row; move that comparison into JavaScript
     * and BOTH succeed, leaving `available` at -1 — which no other assertion
     * in this file would catch.
     */
    it('lets exactly ONE of two concurrent reserves win the last unit', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const variant = await soleVariant(listingId);

      const outcomes = await Promise.allSettled([reserve(variant.id, 1), reserve(variant.id, 1)]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(0);
      expect(after?.inventoryCommitted).toBe(1);
    });

    it('is a no-op for a non-positive quantity', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 4);
      const variant = await soleVariant(listingId);

      await reserve(variant.id, 0);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(4);
    });

    it('throws NOT_FOUND for a variant that does not exist', async () => {
      await expectCode(
        reserve('00000000-0000-0000-0000-0000000000ff', 1),
        ErrorCodes.NOT_FOUND,
      );
    });
  });

  describe('commit, release and restock move the right counter', () => {
    it('commit drops committed and leaves available alone', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 5);
      const variant = await soleVariant(listingId);
      await reserve(variant.id, 2);

      await commit(variant.id, 2);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(3);
      expect(after?.inventoryCommitted).toBe(0);
    });

    it('release returns the units to available', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 5);
      const variant = await soleVariant(listingId);
      await reserve(variant.id, 2);

      await release(variant.id, 2);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(5);
      expect(after?.inventoryCommitted).toBe(0);
    });

    it('restock raises available WITHOUT touching committed', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 5);
      const variant = await soleVariant(listingId);
      await reserve(variant.id, 2);
      await commit(variant.id, 2);

      await restock(variant.id, 2);

      const after = await findVariantById(variant.id);
      expect(after?.inventoryAvailable).toBe(5);
      expect(after?.inventoryCommitted).toBe(0);
    });
  });

  describe('setAvailable is scoped to the listing', () => {
    it('sets available on a variant of the named listing', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const variant = await soleVariant(listingId);

      await setAvailable(variant.id, listingId, 9);

      expect((await findVariantById(variant.id))?.inventoryAvailable).toBe(9);
    });

    /**
     * The IDOR the scoping exists to prevent. Both halves matter: the refusal,
     * AND that the other seller's stock is untouched — a scope check that
     * throws after writing would pass an assertion on the error alone.
     */
    it('refuses a variant belonging to a DIFFERENT listing, and writes nothing', async () => {
      await seedCategory();
      const mine = await seedP2P('seller-a', 1);
      const theirs = await seedP2P('seller-b', 1);
      const theirVariant = await soleVariant(theirs);

      await expectCode(setAvailable(theirVariant.id, mine, 99), ErrorCodes.NOT_FOUND);

      expect((await findVariantById(theirVariant.id))?.inventoryAvailable).toBe(1);
    });

    it('rejects a negative or non-integer value before any lookup', async () => {
      await expectCode(
        setAvailable('00000000-0000-0000-0000-0000000000ff', 'nope', -1),
        ErrorCodes.OUT_OF_STOCK,
      );
    });
  });

  describe('syncListingFacets', () => {
    /**
     * An absent price is NULL, not zero. `listings_price_min_shape_check` pairs
     * each amount with its currency, so both columns must clear together — and
     * a zero would make a priceless listing sort as the cheapest thing in the
     * catalogue.
     */
    it('clears the price columns to NULL when the last variant goes', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1, 4200);
      const variant = await soleVariant(listingId);

      await client()`DELETE FROM product_variants WHERE id = ${variant.id}`;
      await syncListingFacets(listingId);

      const listing = await findListingById(listingId);
      expect(listing?.priceMinAmount).toBeNull();
      expect(listing?.priceMinCurrency).toBeNull();
      expect(listing?.priceMaxAmount).toBeNull();
      expect(listing?.priceMaxCurrency).toBeNull();
      expect(listing?.hasInventory).toBe(false);
      expect(listing?.variantCount).toBe(0);
    });

    it('marks a listing out of stock when its tracked variant empties', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const variant = await soleVariant(listingId);

      await reserve(variant.id, 1);

      expect((await findListingById(listingId))?.hasInventory).toBe(false);
    });
  });

  describe('archiveListing has matchedCount semantics', () => {
    /**
     * Postgres reports `rowCount`, which behaves like Mongo's `matchedCount`.
     * Archiving an ALREADY-archived listing therefore still matches and must
     * succeed — a `status <> 'archived'` predicate would read as
     * `modifiedCount` and turn a harmless retry into a 404.
     */
    it('succeeds a second time on an already-archived listing', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);

      await archiveListing(listingId);
      await expect(archiveListing(listingId)).resolves.toBeUndefined();

      expect((await findListingById(listingId))?.status).toBe('archived');
    });

    it('throws NOT_FOUND for a listing that does not exist', async () => {
      await expectCode(
        archiveListing('00000000-0000-0000-0000-0000000000ff'),
        ErrorCodes.NOT_FOUND,
      );
    });
  });

  describe('updateListing', () => {
    it('stamps publishedAt on the first activation and never re-stamps it', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const first = (await findListingById(listingId))?.publishedAt;
      expect(first).not.toBeNull();

      await updateListing(listingId, { status: 'active' });

      expect((await findListingById(listingId))?.publishedAt).toEqual(first);
    });

    it('routes a P2P price change through the single variant', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1, 1000);

      await updateListing(listingId, { price: { amount: 7777, currency: 'USD' } });

      const variant = await soleVariant(listingId);
      expect(variant.priceAmount).toBe(7777);
      // The denormalized facet follows, or browse would sort on a stale price.
      expect((await findListingById(listingId))?.priceMinAmount).toBe(7777);
    });
  });

  describe('removeVariant', () => {
    it('refuses to remove the last variant of a listing', async () => {
      await seedCategory();
      const listingId = await seedP2P('seller-a', 1);
      const variant = await soleVariant(listingId);

      await expectCode(removeVariant(listingId, variant.id), ErrorCodes.CONFLICT);

      expect(await listVariantsForListing(listingId)).toHaveLength(1);
    });
  });
});

/**
 * The cart domain against a real PostgreSQL server.
 *
 * This file REPLACES `services/__tests__/cart.service.test.ts`, which mocked
 * the Mongoose model. The properties that decide whether this port is correct
 * cannot be expressed against a mock:
 *
 *  - **A cart line is now a ROW with `cart_items_cart_variant_key`**, so a
 *    quantity change is a targeted UPDATE. The source rewrote the whole `items`
 *    array, so two concurrent edits to DIFFERENT lines lost one. That is
 *    asserted below by running them concurrently — a mock has no second
 *    connection and cannot fail it.
 *  - **`cart_items_quantity_check` refuses a zero quantity.** A mock accepts it
 *    and the cart quietly grows a line that means nothing.
 *
 * The target is empty, so "returned nothing" and "correctly returned nothing"
 * are the same observation. Every read seeds TWO buyers and asserts the other's
 * cart is absent.
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
import { listVariantsForListing } from '../../catalog/catalogRepository';
import { createP2PListing, updateListing } from '../../../services/catalog-write.service';
import {
  addItem,
  clearCart,
  getCart,
  removeItem,
  updateItem,
} from '../../../services/cart.service';
import { findCartByUser, upsertCartItem } from '../cartRepository';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

async function seedCategory(): Promise<void> {
  await getDb()
    .insert(categories)
    .values({ name: 'gadgets', slug: 'gadgets', ancestorSlugs: [], isActive: true })
    .onConflictDoNothing();
}

/** A sellable listing with one variant. Returns `{listingId, variantId}`. */
async function seedProduct(
  seller: string,
  quantity: number,
  price = 1000,
  currency: 'USD' | 'EUR' = 'USD',
): Promise<{ listingId: string; variantId: string }> {
  const listingId = await createP2PListing(seller, {
    title: `p-${seller}-${currency}`,
    description: '',
    condition: 'new',
    category: 'gadgets',
    imageFileIds: [],
    price: { amount: price, currency },
    quantity,
  });
  const [variant] = await listVariantsForListing(listingId);
  return { listingId, variantId: variant.id };
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (err: unknown) => isMoovoError(err) && err.code === code,
    `expected a ${code} error`,
  );
}

describeIfPostgres('the cart domain on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    await client()`DELETE FROM cart_items`;
    await client()`DELETE FROM carts`;
    await client()`DELETE FROM product_variants`;
    await client()`DELETE FROM listings`;
    await client()`DELETE FROM categories`;
    await client()`DELETE FROM seller_profiles`;
  });

  describe('a cart belongs to exactly one buyer', () => {
    it('does not return another buyer\'s lines', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);

      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 2 });

      const mine = await getCart('buyer-a');
      const theirs = await getCart('buyer-b');

      expect(mine.items).toHaveLength(1);
      expect(mine.items[0].quantity).toBe(2);
      // The half that fails if the `oxyUserId` filter is dropped.
      expect(theirs.items).toEqual([]);
      expect(theirs.id).toBe('');
    });
  });

  describe('a cart is single-currency', () => {
    it('refuses an item priced in a different currency', async () => {
      await seedCategory();
      const usd = await seedProduct('seller-a', 5, 1000, 'USD');
      const eur = await seedProduct('seller-b', 5, 1000, 'EUR');

      await addItem('buyer-a', { listingId: usd.listingId, variantId: usd.variantId, quantity: 1 });

      await expectCode(
        addItem('buyer-a', { listingId: eur.listingId, variantId: eur.variantId, quantity: 1 }),
        ErrorCodes.CONFLICT,
      );

      // The refusal must leave the cart untouched, not half-written.
      const cart = await getCart('buyer-a');
      expect(cart.items).toHaveLength(1);
      expect(cart.currency).toBe('USD');
    });

    it('lets an EMPTIED cart adopt a new currency', async () => {
      await seedCategory();
      const usd = await seedProduct('seller-a', 5, 1000, 'USD');
      const eur = await seedProduct('seller-b', 5, 1000, 'EUR');

      await addItem('buyer-a', { listingId: usd.listingId, variantId: usd.variantId, quantity: 1 });
      await removeItem('buyer-a', usd.variantId);
      await addItem('buyer-a', { listingId: eur.listingId, variantId: eur.variantId, quantity: 1 });

      expect((await getCart('buyer-a')).currency).toBe('EUR');
    });
  });

  describe('quantities are clamped to live availability', () => {
    it('clamps an add to the variant\'s available stock', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 3);

      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 10 });

      expect((await getCart('buyer-a')).items[0].quantity).toBe(3);
    });

    it('refuses an add when the variant is out of stock', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 0);

      await expectCode(
        addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 1 }),
        ErrorCodes.CONFLICT,
      );
    });

    it('refuses a variant that belongs to a different listing', async () => {
      await seedCategory();
      const a = await seedProduct('seller-a', 5);
      const b = await seedProduct('seller-b', 5);

      await expectCode(
        addItem('buyer-a', { listingId: a.listingId, variantId: b.variantId, quantity: 1 }),
        ErrorCodes.VALIDATION_ERROR,
      );
    });
  });

  describe('stale lines', () => {
    it('flags a line whose listing stopped being active', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 1 });

      await updateListing(product.listingId, { status: 'draft' });

      expect((await getCart('buyer-a')).items[0].stale).toBe(true);
    });

    it('does NOT flag a healthy line (negative control)', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 1 });

      // Without this, "everything is stale" would satisfy the case above.
      expect((await getCart('buyer-a')).items[0].stale).toBeUndefined();
    });
  });

  /**
   * The property the sub-document array could not hold.
   *
   * Two lines, edited at once. The source read the whole `items` array, edited
   * one entry and saved it back, so the second write reverted the first. With
   * each line a row keyed by `(cart_id, variant_id)`, both survive.
   */
  describe('concurrent edits to different lines both survive', () => {
    it('keeps both quantities after two simultaneous updates', async () => {
      await seedCategory();
      const first = await seedProduct('seller-a', 9);
      const second = await seedProduct('seller-b', 9);

      await addItem('buyer-a', { listingId: first.listingId, variantId: first.variantId, quantity: 1 });
      await addItem('buyer-a', { listingId: second.listingId, variantId: second.variantId, quantity: 1 });

      await Promise.all([
        updateItem('buyer-a', first.variantId, 4),
        updateItem('buyer-a', second.variantId, 7),
      ]);

      const cart = await getCart('buyer-a');
      const byVariant = new Map(cart.items.map((i) => [i.variantId, i.quantity]));
      expect(byVariant.get(first.variantId)).toBe(4);
      expect(byVariant.get(second.variantId)).toBe(7);
    });
  });

  describe('the quantity CHECK', () => {
    it('refuses a zero-quantity line at the database', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 1 });
      const cart = await findCartByUser('buyer-a');
      if (!cart) throw new Error('cart missing');

      await expect(
        upsertCartItem(cart.id, {
          listingId: product.listingId,
          variantId: product.variantId,
          quantity: 0,
        }),
      ).rejects.toThrow();
    });
  });

  describe('updateItem and removeItem', () => {
    it('removes the line when the quantity is set to zero', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 2 });

      await updateItem('buyer-a', product.variantId, 0);

      expect((await getCart('buyer-a')).items).toEqual([]);
    });

    it('throws NOT_FOUND for a line that is not in the cart', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 1 });

      await expectCode(
        updateItem('buyer-a', '00000000-0000-0000-0000-0000000000ff', 1),
        ErrorCodes.NOT_FOUND,
      );
    });
  });

  describe('clearCart', () => {
    it('empties the lines and keeps the cart row', async () => {
      await seedCategory();
      const product = await seedProduct('seller-a', 5);
      await addItem('buyer-a', { listingId: product.listingId, variantId: product.variantId, quantity: 2 });

      await clearCart('buyer-a');

      expect((await getCart('buyer-a')).items).toEqual([]);
      // The cart itself survives — checkout empties it, it does not delete it.
      expect(await findCartByUser('buyer-a')).not.toBeNull();
    });

    it('is a no-op for a buyer with no cart', async () => {
      await expect(clearCart('buyer-nobody')).resolves.toBeUndefined();
    });
  });
});

/**
 * Every statement the cart domain issues against `carts` and `cart_items`.
 *
 * ## A cart line has real identity here, and that removes a race
 *
 * The source stored lines as a `{_id: false}` sub-document array, so "change
 * this line's quantity" was a read-modify-write over the WHOLE array: two
 * concurrent requests for the same cart each read the array, each edited their
 * line, and the second `save()` overwrote the first. As a child table with
 * `cart_items_cart_variant_key` a line is a row, and the same operation is a
 * targeted UPDATE that cannot lose a sibling's edit.
 *
 * That is a deliberate STRENGTHENING, called out because a port that silently
 * changes behaviour is indistinguishable from one that broke something.
 *
 * ## The cart stores no price
 *
 * Lines carry a variant reference and a quantity, never a price — prices are
 * read live at hydration, which is what makes a price change visible
 * immediately. Nothing here should ever gain a price column.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { cartItems, carts } from '../schema/commerce';

export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;

/** A cart with its lines, oldest line first. */
export interface CartRecord {
  id: string;
  oxyUserId: string;
  currency: string;
  items: CartItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

/** One cart line. */
export interface CartItemRecord {
  listingId: string;
  variantId: string;
  quantity: number;
  addedAt: Date;
}

function toItemRecord(row: CartItemRow): CartItemRecord {
  return {
    listingId: row.listingId,
    variantId: row.variantId,
    quantity: row.quantity,
    addedAt: row.addedAt,
  };
}

/** Lines of one cart, in the order they were added. */
async function itemsOf(cartId: string, db: DatabaseOrTransaction): Promise<CartItemRow[]> {
  return await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.id));
}

/** The buyer's cart with its lines, or `null` if they have none yet. */
export async function findCartByUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRecord | null> {
  const [row] = await db.select().from(carts).where(eq(carts.oxyUserId, oxyUserId)).limit(1);
  if (row === undefined) return null;
  const items = await itemsOf(row.id, db);
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    currency: row.currency,
    items: items.map(toItemRecord),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The buyer's cart, created empty in `currency` if they have none.
 *
 * `ON CONFLICT DO NOTHING` on `carts_oxy_user_id_key` followed by a read: two
 * concurrent first-adds both try to insert, the loser inserts nothing and reads
 * the winner's row. A prior existence check would only narrow that window.
 */
export async function ensureCart(
  oxyUserId: string,
  currency: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CartRow> {
  const inserted = await db
    .insert(carts)
    .values({ oxyUserId, currency })
    .onConflictDoNothing({ target: carts.oxyUserId })
    .returning();
  if (inserted.length > 0) return inserted[0];

  const [existing] = await db
    .select()
    .from(carts)
    .where(eq(carts.oxyUserId, oxyUserId))
    .limit(1);
  return existing;
}

/** Set a cart's currency. Only valid while it holds no lines. */
export async function updateCartCurrency(
  cartId: string,
  currency: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(carts).set({ currency }).where(eq(carts.id, cartId));
}

/**
 * Set a line's ABSOLUTE quantity, inserting it if absent.
 *
 * `excluded.<col>` is spelled out rather than interpolated: interpolating the
 * column object emits the JS property name, so `cart_items.listingId` would
 * become `excluded.listingid` and fail at runtime with 42703.
 */
export async function upsertCartItem(
  cartId: string,
  line: { listingId: string; variantId: string; quantity: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(cartItems)
    .values({
      cartId,
      listingId: line.listingId,
      variantId: line.variantId,
      quantity: line.quantity,
    })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.variantId],
      set: { quantity: sql`excluded.quantity` },
    });
}

/** Remove one line. Returns whether a row went. */
export async function deleteCartItem(
  cartId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)));
  return (result.count ?? 0) > 0;
}

/** Remove every line of a cart, keeping the cart itself. */
export async function clearCartItems(
  cartId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
}

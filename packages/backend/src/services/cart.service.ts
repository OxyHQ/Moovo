/**
 * Cart service — the buyer's single-currency basket.
 *
 * The cart stores ONLY variant references + quantities; prices and availability
 * are read LIVE from the variant every time the cart is hydrated, so a price
 * change or stock drop is reflected immediately (a line whose variant/listing is
 * gone, or whose `available` fell below its quantity, is flagged `stale`).
 *
 * Invariants:
 *   - single-currency: a cart's `currency` is fixed by its first item; adding a
 *     variant in a different currency is a CONFLICT.
 *   - quantities are clamped to the variant's live `available` (when tracked)
 *     and to `config.cart.maxQuantityPerItem`.
 *   - NO inventory is reserved here — reservation happens at checkout (F4). The
 *     cart is a soft wishlist-to-buy.
 */

import type {
  AddCartItemInput,
  Cart as CartDTO,
  CartItemDTO,
  CurrencyCode,
  Money,
} from '@moovo/shared-types';
import {
  clearCartItems,
  deleteCartItem,
  ensureCart,
  findCartByUser,
  updateCartCurrency,
  upsertCartItem,
  type CartRecord,
} from '../db/commerce/cartRepository.js';
import {
  findListingById,
  findListingsByIds,
  findVariantById,
  listVariantsForListings,
} from '../db/catalog/catalogRepository.js';
import {
  toListingRecord,
  toProductVariantRecord,
  type ListingRecord,
  type ProductVariantRecord,
} from '../db/catalog/catalogShape.js';
import { resolveMedia } from './media.service.js';
import { multiplyMoney, sumMoney } from '../utils/money.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';

/** Map a stored money pair to the `Money` DTO. */
function toMoney(value: { amount: number; currency: string }): Money {
  return { amount: value.amount, currency: value.currency as CurrencyCode };
}

/** First gallery image (lowest `position`) of a listing, resolved through the media chokepoint. */
function firstImageUrl(listing: ListingRecord | undefined): string | undefined {
  if (!listing || listing.images.length === 0) {
    return undefined;
  }
  const first = [...listing.images].sort((a, b) => a.position - b.position)[0];
  return first ? resolveMedia(first.fileId, 'thumb') : undefined;
}

/** Clamp a requested quantity to `[1, maxQuantityPerItem]` and the live ceiling. */
function clampQuantity(requested: number, tracked: boolean, available: number): number {
  const ceiling = tracked ? Math.min(config.cart.maxQuantityPerItem, available) : config.cart.maxQuantityPerItem;
  return Math.max(0, Math.min(requested, ceiling));
}

/**
 * Build the hydrated `Cart` DTO for a stored cart document, reading live prices
 * and availability from the variants. A line whose variant/listing is gone, or
 * whose live `available` is below its quantity, is flagged `stale`.
 */
async function buildCartDTO(cart: CartRecord): Promise<CartDTO> {
  const currency = cart.currency as CurrencyCode;
  const id = cart.id;

  if (cart.items.length === 0) {
    return { id, items: [], currency, subtotal: { amount: 0, currency } };
  }

  const listingIds = cart.items.map((i) => i.listingId);

  // Variants are fetched BY LISTING rather than by variant id: the cart's own
  // line already names the listing, and one batched read covers both maps.
  const [variantRows, listingRows] = await Promise.all([
    listVariantsForListings(listingIds),
    findListingsByIds(listingIds),
  ]);

  const variantById = new Map<string, ProductVariantRecord>(
    variantRows.map((v) => [v.id, toProductVariantRecord(v)]),
  );
  const listingById = new Map<string, ListingRecord>(
    listingRows.map((l) => [l.id, toListingRecord(l)]),
  );

  const items: CartItemDTO[] = cart.items.map((item) => {
    const { variantId, listingId } = item;
    const variant = variantById.get(variantId);
    const listing = listingById.get(listingId);

    // Missing variant/listing → a zero-priced, stale line the buyer must remove.
    if (!variant || !listing) {
      const unitPrice: Money = { amount: 0, currency };
      return {
        listingId,
        variantId,
        title: listing?.title ?? 'Unavailable item',
        variantTitle: variant?.title ?? '',
        unitPrice,
        quantity: item.quantity,
        available: 0,
        lineTotal: { amount: 0, currency },
        stale: true,
      };
    }

    const available = variant.inventory.available;
    const tracked = variant.inventory.tracked;
    const unitPrice = toMoney(variant.price);
    const lineTotal = multiplyMoney(unitPrice, item.quantity);
    const imageUrl = firstImageUrl(listing);

    const dto: CartItemDTO = {
      listingId,
      variantId,
      title: listing.title,
      variantTitle: variant.title,
      unitPrice,
      quantity: item.quantity,
      available,
      lineTotal,
    };
    if (imageUrl !== undefined) {
      dto.imageUrl = imageUrl;
    }
    // Tracked + understocked, or listing no longer sellable → stale.
    if ((tracked && available < item.quantity) || listing.status !== 'active') {
      dto.stale = true;
    }
    return dto;
  });

  const subtotal = sumMoney(
    items.map((i) => i.lineTotal),
    currency,
  );

  return { id, items, currency, subtotal };
}

/** Load the buyer's stored cart, or `null` if they have none yet. */
async function loadCart(oxyUserId: string): Promise<CartRecord | null> {
  return await findCartByUser(oxyUserId);
}

/**
 * Get the buyer's cart, hydrated with live unit prices, availability and a
 * subtotal. Returns an empty cart (no document yet) as an empty USD cart.
 */
export async function getCart(oxyUserId: string): Promise<CartDTO> {
  const cart = await loadCart(oxyUserId);
  if (!cart) {
    return { id: '', items: [], currency: 'USD', subtotal: { amount: 0, currency: 'USD' } };
  }
  return buildCartDTO(cart);
}

/**
 * Add a variant to the cart (or increment it if already present), then return
 * the freshly hydrated cart.
 *
 * Validates the listing + variant exist and the listing is sellable (`active`);
 * enforces a single-currency cart (CONFLICT if the variant's currency differs
 * from an existing cart's currency); clamps the resulting quantity to the
 * variant's live `available` (when tracked) and `maxQuantityPerItem`.
 */
export async function addItem(oxyUserId: string, input: AddCartItemInput): Promise<CartDTO> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw validationError('quantity must be a positive integer');
  }

  const [listingRow, variantRow] = await Promise.all([
    findListingById(input.listingId),
    findVariantById(input.variantId),
  ]);

  if (!listingRow) {
    throw notFound('Listing not found');
  }
  if (!variantRow) {
    throw notFound('Variant not found');
  }
  const listing = toListingRecord(listingRow);
  const variant = toProductVariantRecord(variantRow);
  if (variant.listingId !== listing.id) {
    throw validationError('Variant does not belong to the given listing');
  }
  if (listing.status !== 'active') {
    throw conflict('Listing is not available for purchase');
  }

  const variantCurrency = variant.price.currency as CurrencyCode;
  const tracked = variant.inventory.tracked;
  const available = variant.inventory.available;
  if (tracked && available <= 0) {
    throw conflict('Variant is out of stock');
  }

  const existingCart = await findCartByUser(oxyUserId);

  // Single-currency cart enforcement, checked BEFORE anything is written.
  if (existingCart && existingCart.items.length > 0 && existingCart.currency !== variantCurrency) {
    throw conflict(
      `Cart is in ${existingCart.currency}; cannot add an item priced in ${variantCurrency}`,
    );
  }

  const existingLine = existingCart?.items.find((i) => i.variantId === input.variantId);
  const desired = (existingLine?.quantity ?? 0) + input.quantity;
  const quantity = clampQuantity(desired, tracked, available);
  if (quantity <= 0) {
    throw conflict('Variant is out of stock');
  }

  const cart = await ensureCart(oxyUserId, variantCurrency);

  // An empty cart adopts the new item's currency; a non-empty one already
  // agreed with it above.
  if (!existingCart || existingCart.items.length === 0) {
    await updateCartCurrency(cart.id, variantCurrency);
  }

  await upsertCartItem(cart.id, {
    listingId: input.listingId,
    variantId: input.variantId,
    quantity,
  });

  return getCart(oxyUserId);
}

/**
 * Set the absolute quantity of a variant already in the cart. A quantity of `0`
 * removes the line. The new quantity is clamped to live availability (tracked)
 * and `maxQuantityPerItem`. Returns the freshly hydrated cart.
 */
export async function updateItem(
  oxyUserId: string,
  variantId: string,
  quantity: number,
): Promise<CartDTO> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw validationError('quantity must be a non-negative integer');
  }

  const cart = await findCartByUser(oxyUserId);
  if (!cart) {
    throw notFound('Cart not found');
  }

  const line = cart.items.find((i) => i.variantId === variantId);
  if (!line) {
    throw notFound('Item not in cart');
  }

  if (quantity === 0) {
    await deleteCartItem(cart.id, variantId);
    return getCart(oxyUserId);
  }

  const variantRow = await findVariantById(variantId);
  if (!variantRow) {
    throw notFound('Variant not found');
  }
  const variant = toProductVariantRecord(variantRow);

  const clamped = clampQuantity(quantity, variant.inventory.tracked, variant.inventory.available);
  if (clamped <= 0) {
    throw conflict('Variant is out of stock');
  }

  // A targeted UPDATE of ONE line. The source rewrote the whole `items` array,
  // so a concurrent edit to a different line was silently overwritten.
  await upsertCartItem(cart.id, {
    listingId: line.listingId,
    variantId,
    quantity: clamped,
  });

  return getCart(oxyUserId);
}

/** Remove a variant line from the cart. Returns the freshly hydrated cart. */
export async function removeItem(oxyUserId: string, variantId: string): Promise<CartDTO> {
  const cart = await findCartByUser(oxyUserId);
  if (!cart) {
    throw notFound('Cart not found');
  }

  await deleteCartItem(cart.id, variantId);
  return getCart(oxyUserId);
}

/**
 * Empty the buyer's cart (used by F4 checkout once orders are created). Removes
 * all line items; the cart document is retained.
 */
export async function clearCart(oxyUserId: string): Promise<void> {
  const cart = await findCartByUser(oxyUserId);
  if (!cart) return;
  await clearCartItems(cart.id);
}

/**
 * Revalidate a stored cart against current catalog state, returning the cart DTO
 * with live prices/availability and `stale` flags. Does NOT mutate stored data
 * (there is no stored price to drift); the cart view and later checkout call
 * this to surface stale lines before payment.
 */
export async function revalidate(cart: CartRecord): Promise<CartDTO> {
  return buildCartDTO(cart);
}

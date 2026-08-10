/**
 * Inventory service — race-safe, variant-level stock atomicity WITHOUT
 * transactions.
 *
 * Each mutation is a single guarded UPDATE against the variant row, so two
 * concurrent reserves cannot both succeed past the available stock: the
 * `available >= qty` guard lives in the WHERE clause, so at most one wins and
 * the loser matches no row. Untracked variants short-circuit (always
 * available). The multi-location seam (`inventory_levels`) reuses these same
 * signatures in the future — not built here.
 *
 * `available` is decremented at RESERVE time and `committed` raised; `commit`
 * finalizes a sale (drop `committed`, stock already gone); `release` returns a
 * reservation (raise `available`, drop `committed`).
 *
 * **The guard must stay in the WHERE clause.** Reading the row, comparing in
 * JavaScript and then writing would look equivalent and would reintroduce
 * exactly the race this file exists to avoid — and with both stores empty it
 * would pass every test that does not run two callers concurrently.
 */

import {
  adjustVariantStock,
  findListingById,
  findVariant,
  findVariantById,
  reserveVariantStock,
  updateVariantRow,
} from '../db/catalog/catalogRepository.js';
import { outOfStock, notFound } from '../lib/errors/error-codes.js';
import { syncListingFacets } from './catalog-write.service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/** Fetch the minimal tracked/listing info for a variant, or null if missing. */
async function loadVariantMeta(
  variantId: string,
): Promise<{ listingId: string; tracked: boolean } | null> {
  const row = await findVariantById(variantId);
  if (!row) {
    return null;
  }
  return { listingId: row.listingId, tracked: row.inventoryTracked };
}

/**
 * Reserve `qty` units of a variant. For a TRACKED variant this atomically
 * decrements `available` and raises `committed`, guarded so it can only succeed
 * when `available >= qty`; a losing/insufficient call throws `OUT_OF_STOCK`. An
 * UNTRACKED variant short-circuits (no stock to hold).
 */
export async function reserve(variantId: string, qty: number): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  const reserved = await reserveVariantStock(variantId, qty);
  if (!reserved) {
    throw outOfStock('Insufficient stock to reserve');
  }

  await syncListingFacets(meta.listingId);

  await maybeAlertLowStock(variantId, meta.listingId);
}

/**
 * Best-effort low-stock alert for a STORE-owned tracked variant after a reserve
 * drops its `available` to/below the threshold. Never throws — a notification
 * failure must not affect the reservation. Uses a dynamic import of the queue
 * producer to avoid any module load-order fragility from the inventory ↔ queue
 * dependency cycle.
 */
async function maybeAlertLowStock(variantId: string, listingId: string): Promise<void> {
  try {
    const variant = await findVariantById(variantId);
    if (!variant || !variant.inventoryTracked) {
      return;
    }
    if (variant.inventoryAvailable > config.orders.lowStockThreshold) {
      return;
    }

    const listing = await findListingById(listingId);
    if (!listing || listing.ownerType !== 'store' || listing.storeId === null) {
      return;
    }

    const { enqueueLowStockAlert } = await import('../queue/producers.js');
    await enqueueLowStockAlert({
      storeId: listing.storeId,
      listingId,
      variantId,
      variantTitle: variant.title,
      available: variant.inventoryAvailable,
    });
  } catch (err) {
    log.general.warn({ err, variantId, listingId }, 'Failed to evaluate/enqueue low-stock alert');
  }
}

/**
 * Commit a reserved `qty` (sale finalized). `available` was already decremented
 * at reserve time, so this only drops `committed`. Untracked short-circuits.
 */
export async function commit(variantId: string, qty: number): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  await adjustVariantStock(variantId, { committed: -qty });
}

/**
 * Release a reserved `qty` (reservation cancelled/expired). Raises `available`
 * and drops `committed`. Untracked short-circuits. Recomputes facets in case the
 * variant flips back into stock.
 */
export async function release(variantId: string, qty: number): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  await adjustVariantStock(variantId, { available: qty, committed: -qty });

  await syncListingFacets(meta.listingId);
}

/**
 * Raise `available` WITHOUT touching `committed` — used to return stock to the
 * pool on refund of an already-committed (paid) order, where `commit` already
 * zeroed the committed units. Tracked-only; untracked short-circuits; non-positive
 * quantities are a no-op. Recomputes facets in case the variant flips back into
 * stock.
 */
export async function restock(variantId: string, qty: number): Promise<void> {
  if (qty <= 0) {
    return;
  }
  const meta = await loadVariantMeta(variantId);
  if (!meta) {
    throw notFound('Variant not found');
  }
  if (!meta.tracked) {
    return;
  }

  await adjustVariantStock(variantId, { available: qty });

  await syncListingFacets(meta.listingId);
}

/**
 * Admin absolute-set of `available` units on a TRACKED variant (e.g. restock).
 * Scoped to `listingId` so a store member can only set inventory on a variant
 * belonging to a listing they own — a variant whose `listingId` does not match
 * resolves to NOT_FOUND. Untracked variants ignore the value (always available).
 * Recomputes the parent listing's facets so `hasInventory`/`priceRange` reflect
 * the new state.
 */
export async function setAvailable(
  variantId: string,
  listingId: string,
  available: number,
): Promise<void> {
  if (available < 0 || !Number.isInteger(available)) {
    throw outOfStock('available must be a non-negative integer');
  }
  const variant = await findVariant(listingId, variantId);
  if (!variant) {
    throw notFound('Variant not found');
  }

  if (variant.inventoryTracked) {
    await updateVariantRow(listingId, variantId, { inventoryAvailable: available });
  }

  await syncListingFacets(listingId);
}

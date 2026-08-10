/**
 * Store products controller (THIN) — the store-owned catalog write path.
 *
 * Every product mutation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a product (Listing) is only operable here if its `storeId`
 * matches. Creation/updates funnel through `catalog-write.service`; inventory
 * absolute-sets go through `inventory.service.setAvailable`. Responses are
 * hydrated via `catalog-hydration.service` so they match the public read shape.
 */

import type { Request, Response } from 'express';
import type {
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  UpdateListingInput,
  Listing as ListingDTO,
} from '@moovo/shared-types';
import { findListingById, listListingsForOwner } from '../../db/catalog/catalogRepository.js';
import { toListingRecord, type ListingRecord } from '../../db/catalog/catalogShape.js';
import {
  createStoreProduct,
  updateListing,
  archiveListing,
  addVariant,
  updateVariant,
  removeVariant,
  type UpdateVariantInput,
} from '../../services/catalog-write.service.js';
import { setAvailable } from '../../services/inventory.service.js';
import { hydrateListings } from '../../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../../utils/pagination.js';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { respondWithError, forbidden, notFound } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return store.id;
}

/** Load a product and assert it belongs to the loaded store, else NOT_FOUND/FORBIDDEN. */
async function loadStoreProduct(req: Request): Promise<ListingRecord> {
  const id = routeParam(req, 'id');
  const row = await findListingById(id);
  if (!row) {
    throw notFound('Product not found');
  }
  const listing = toListingRecord(row);
  if (listing.ownerType !== 'store' || listing.storeId !== storeId(req)) {
    throw forbidden('Product does not belong to this store');
  }
  return listing;
}

/** Hydrate a single listing by id into its `Listing` DTO. */
async function hydrateById(listingId: string): Promise<ListingDTO | undefined> {
  const row = await findListingById(listingId);
  if (!row) {
    return undefined;
  }
  const [dto] = await hydrateListings([toListingRecord(row)]);
  return dto;
}

/** GET /admin/stores/:storeId/products — the store's products (any status). */
export async function listProducts(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const { page, limit } = parsePagination(req.query);
    // No status filter: a store admin sees drafts and archived products too.
    const result = await listListingsForOwner({ ownerType: 'store', storeId: id }, {}, page, limit);

    const data = await hydrateListings(result.listings.map(toListingRecord));
    sendPaginated(res, data, buildPagination(page, limit, result.total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store products');
    respondWithError(res, err, 'Failed to load products');
  }
}

/** POST /admin/stores/:storeId/products — create a store product. */
export async function createProduct(req: Request, res: Response): Promise<void> {
  try {
    const id = storeId(req);
    const listingId = await createStoreProduct(id, req.body as CreateStoreProductInput);
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store product');
    respondWithError(res, err, 'Failed to create product');
  }
}

/** GET /admin/stores/:storeId/products/:id — a single store product. */
export async function getProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const dto = await hydrateById(listing.id);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to load store product');
    respondWithError(res, err, 'Failed to load product');
  }
}

/** PATCH /admin/stores/:storeId/products/:id — update a store product. */
export async function patchProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await updateListing(listingId, req.body as UpdateListingInput);
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to update store product');
    respondWithError(res, err, 'Failed to update product');
  }
}

/** DELETE /admin/stores/:storeId/products/:id — archive a store product. */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    await archiveListing(listing.id);
    sendSuccess(res, { id: listing.id, status: 'archived' });
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to delete store product');
    respondWithError(res, err, 'Failed to delete product');
  }
}

/** POST /admin/stores/:storeId/products/:id/variants — add a variant. */
export async function createVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await addVariant(listingId, req.body as CreateStoreProductVariantInput);
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err, productId: req.params.id }, 'Failed to add variant');
    respondWithError(res, err, 'Failed to add variant');
  }
}

/** PATCH /admin/stores/:storeId/products/:id/variants/:variantId — update a variant. */
export async function patchVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await updateVariant(listingId, routeParam(req, 'variantId'), req.body as UpdateVariantInput);
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to update variant');
    respondWithError(res, err, 'Failed to update variant');
  }
}

/** DELETE /admin/stores/:storeId/products/:id/variants/:variantId — remove a variant. */
export async function deleteVariant(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    await removeVariant(listingId, routeParam(req, 'variantId'));
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to remove variant');
    respondWithError(res, err, 'Failed to remove variant');
  }
}

/** PATCH /admin/stores/:storeId/products/:id/variants/:variantId/inventory — set available. */
export async function setVariantInventory(req: Request, res: Response): Promise<void> {
  try {
    const listing = await loadStoreProduct(req);
    const listingId = listing.id;
    const body = req.body as { available: number };
    await setAvailable(routeParam(req, 'variantId'), listingId, body.available);
    const dto = await hydrateById(listingId);
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, variantId: req.params.variantId }, 'Failed to set inventory');
    respondWithError(res, err, 'Failed to set inventory');
  }
}

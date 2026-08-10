/**
 * Stores controller (THIN).
 *
 * `GET /stores/:handle` resolves a store by handle and returns its public
 * `MerchantSummary` projection together with a paginated page of its active
 * listings.
 */

import type { Request, Response } from 'express';
import type { MerchantSummary, Listing, Pagination } from '@moovo/shared-types';
import { findStoreByHandle } from '../db/stores/storeRepository.js';
import { listListingsForOwner } from '../db/catalog/catalogRepository.js';
import { toListingRecord } from '../db/catalog/catalogShape.js';
import { hydrateListings, toMerchantSummary } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Response shape for the public store page. */
interface StorePageResponse {
  store: MerchantSummary;
  listings: Listing[];
  pagination: Pagination;
}

/** GET /stores/:handle — public store page (merchant summary + active listings). */
export async function getStoreByHandle(req: Request, res: Response): Promise<void> {
  const raw = req.params.handle;
  const handle = Array.isArray(raw) ? raw[0] : raw;
  try {
    const store = await findStoreByHandle(handle);
    if (store === null || store.status === 'closed') {
      throw notFound('Store not found');
    }

    const { page, limit } = parsePagination(req.query);
    const result = await listListingsForOwner(
      { ownerType: 'store', storeId: store.id },
      { status: 'active' },
      page,
      limit,
    );
    const listingRecords = result.listings.map(toListingRecord);

    const listings = await hydrateListings(listingRecords);

    const body: StorePageResponse = {
      store: toMerchantSummary(store, listingRecords),
      listings,
      pagination: buildPagination(page, limit, result.total),
    };
    sendSuccess(res, body);
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load store');
    respondWithError(res, err, 'Failed to load store');
  }
}

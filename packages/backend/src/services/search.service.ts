/**
 * Listing search/browse service.
 *
 * Since the catalogue moved to PostgreSQL this is a TRANSLATION and nothing
 * else: it hands a `ListingQuery` to `db/catalog/catalogRepository`, converts
 * the rows to records, and owns the one thing the repository deliberately does
 * not — the opaque CURSOR.
 *
 * Two pagination paths, as before:
 *  - OFFSET (`searchListingsOffset`) — backs default/`price_*` browse with
 *    `page`/`limit` + a total count, returning a `PaginatedResponse`;
 *  - CURSOR (`searchListingsCursor`) — backs the infinite `newest` browse.
 *
 * **The filter and ordering semantics live in the repository, not here**, with
 * four translations that fail by returning a plausible page rather than an
 * error (array containment, `NULLS LAST`, the written-out keyset boundary, and
 * the distance operator). They are pinned by
 * `db/catalog/__tests__/catalog-reads.realdb.test.ts`; do not restate them.
 */

import type { ListingQuery } from '@moovo/shared-types';
import {
  searchListingsCursor as queryListingsCursor,
  searchListingsOffset as queryListingsOffset,
} from '../db/catalog/catalogRepository.js';
import { toListingRecord, type ListingRecord } from '../db/catalog/catalogShape.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';

/** A page of listings produced by the cursor browse path. */
export interface CursorSearchResult {
  listings: ListingRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

/** A page of listings produced by the offset browse path. */
export interface OffsetSearchResult {
  listings: ListingRecord[];
  total: number;
}

/** Offset-paginated browse, with the total the pagination envelope needs. */
export async function searchListingsOffset(
  query: ListingQuery,
  page: number,
  limit: number,
): Promise<OffsetSearchResult> {
  const result = await queryListingsOffset(query, page, limit);
  return { listings: result.listings.map(toListingRecord), total: result.total };
}

/**
 * Cursor-paginated browse for the infinite `newest` feed.
 *
 * The cursor is encoded from `publishedAt ?? createdAt`, which is what the
 * source did: an undated listing still needs a boundary value, and the
 * repository's keyset admits undated rows explicitly rather than comparing
 * against one.
 */
export async function searchListingsCursor(
  query: ListingQuery,
  limit: number,
): Promise<CursorSearchResult> {
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  const result = await queryListingsCursor(query, limit, decoded);
  const listings = result.listings.map(toListingRecord);

  let nextCursor: string | undefined;
  if (result.hasMore && listings.length > 0) {
    const last = listings[listings.length - 1];
    nextCursor = encodeCursor(last.publishedAt ?? last.createdAt, last.id);
  }

  return { listings, nextCursor, hasMore: result.hasMore };
}

/**
 * The catalogue read paths against a real PostgreSQL + PostGIS server.
 *
 * Every case below exists because the translation it guards is accepted by
 * `tsc` and by any mocked repository, and produces a plausible EMPTY or
 * MIS-ORDERED page rather than an error:
 *
 *  - array containment read as equality returns nothing, which looks like an
 *    empty category;
 *  - `DESC` without `NULLS LAST` reverses where undated rows sit;
 *  - a keyset boundary written as a row comparison drops undated rows and the
 *    page simply comes back short;
 *  - a radius filter or a text match against the wrong column returns
 *    everything or nothing, both of which look like data.
 *
 * The target is empty, so a read returning nothing and a read correctly
 * returning nothing are the same observation. Every case therefore seeds rows
 * that MUST be excluded alongside the ones that must be returned.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import { getDb } from '../../postgres';
import { listings } from '../../schema/catalog';
import {
  findCategoryBySlug,
  listActiveCategories,
  listListingsForOwner,
  listVariantsForListings,
  searchListingsCursor,
  searchListingsOffset,
} from '../catalogRepository';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** Insert one active P2P listing. `publishedAt: null` is a deliberate shape. */
async function seedListing(input: {
  title: string;
  owner: string;
  publishedAt: Date | null;
  categorySlugs?: string[];
  priceMin?: number;
  tags?: string[];
  description?: string;
  status?: string;
  coords?: { lng: number; lat: number };
}) {
  const [row] = await getDb()
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: input.owner,
      title: input.title,
      description: input.description ?? '',
      condition: 'new',
      status: input.status ?? 'active',
      categorySlugs: input.categorySlugs ?? [],
      tags: input.tags ?? [],
      publishedAt: input.publishedAt,
      ...(input.priceMin === undefined
        ? {}
        : { priceMinAmount: input.priceMin, priceMinCurrency: 'USD' }),
      ...(input.coords === undefined
        ? {}
        : { latitude: input.coords.lat, longitude: input.coords.lng }),
    })
    .returning();
  return row;
}

const ALL: Parameters<typeof searchListingsOffset>[0] = {};

describeIfPostgres('the catalogue read paths on a real server', () => {
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
  });

  describe('category filtering is array CONTAINMENT', () => {
    it('matches a listing whose categorySlugs CONTAINS the value', async () => {
      await seedListing({
        title: 'in-category',
        owner: 'u1',
        publishedAt: new Date('2026-01-01'),
        categorySlugs: ['electronics', 'phones'],
      });
      await seedListing({
        title: 'other-category',
        owner: 'u1',
        publishedAt: new Date('2026-01-02'),
        categorySlugs: ['garden'],
      });

      // `eq()` compares the whole array to a scalar and matches NOTHING, which
      // would return an empty page and read as an empty category.
      const page = await searchListingsOffset({ category: 'phones' }, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['in-category']);
      expect(page.total).toBe(1);
    });

    it('matches on an ancestor slug, not only the leaf', async () => {
      await seedListing({
        title: 'nested',
        owner: 'u1',
        publishedAt: new Date('2026-01-01'),
        categorySlugs: ['electronics', 'phones'],
      });
      expect((await searchListingsOffset({ category: 'electronics' }, 1, 10)).listings).toHaveLength(1);
      expect((await searchListingsOffset({ category: 'absent' }, 1, 10)).listings).toHaveLength(0);
    });
  });

  describe('descending date order puts undated rows LAST', () => {
    it('orders newest first with a NULL publishedAt at the end', async () => {
      await seedListing({ title: 'older', owner: 'u1', publishedAt: new Date('2026-01-01') });
      await seedListing({ title: 'newest', owner: 'u1', publishedAt: new Date('2026-03-01') });
      await seedListing({ title: 'undated', owner: 'u1', publishedAt: null });

      // Postgres orders NULLs FIRST on a DESC sort; Mongo orders a missing
      // value LAST. Without `NULLS LAST` the undated row heads the feed.
      const page = await searchListingsOffset({ sort: 'newest' }, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['newest', 'older', 'undated']);
    });

    it('orders by price with undated prices last', async () => {
      await seedListing({ title: 'cheap', owner: 'u1', publishedAt: new Date('2026-01-01'), priceMin: 100 });
      await seedListing({ title: 'dear', owner: 'u1', publishedAt: new Date('2026-01-01'), priceMin: 900 });
      await seedListing({ title: 'unpriced', owner: 'u1', publishedAt: new Date('2026-01-01') });

      const asc = await searchListingsOffset({ sort: 'price_asc' }, 1, 10);
      expect(asc.listings.map((l) => l.title)).toEqual(['cheap', 'dear', 'unpriced']);
      const desc = await searchListingsOffset({ sort: 'price_desc' }, 1, 10);
      expect(desc.listings.map((l) => l.title)).toEqual(['dear', 'cheap', 'unpriced']);
    });
  });

  describe('the cursor boundary does not drop undated rows', () => {
    it('pages through dated AND undated listings without losing any', async () => {
      await seedListing({ title: 'a', owner: 'u1', publishedAt: new Date('2026-03-01') });
      await seedListing({ title: 'b', owner: 'u1', publishedAt: new Date('2026-02-01') });
      await seedListing({ title: 'c', owner: 'u1', publishedAt: null });

      const first = await searchListingsCursor({}, 2, null);
      expect(first.listings.map((l) => l.title)).toEqual(['a', 'b']);
      expect(first.hasMore).toBe(true);

      const last = first.listings[first.listings.length - 1];
      const second = await searchListingsCursor({}, 2, {
        publishedAt: last.publishedAt as Date,
        id: last.id,
      });

      // The undated row is the one a row-comparison boundary silently drops:
      // `(published_at, id) < (…)` is NULL for it, so it never appears and the
      // page just comes back empty.
      expect(second.listings.map((l) => l.title)).toEqual(['c']);
      expect(second.hasMore).toBe(false);
    });

    it('does not repeat a row across pages', async () => {
      const at = new Date('2026-02-01');
      await seedListing({ title: 'x', owner: 'u1', publishedAt: at });
      await seedListing({ title: 'y', owner: 'u1', publishedAt: at });

      const first = await searchListingsCursor({}, 1, null);
      const cursorRow = first.listings[0];
      const second = await searchListingsCursor({}, 1, {
        publishedAt: cursorRow.publishedAt as Date,
        id: cursorRow.id,
      });

      // Same timestamp on both rows: the id tiebreak is what stops the first
      // row coming back forever.
      expect(second.listings.map((l) => l.id)).not.toContain(cursorRow.id);
      expect(second.listings).toHaveLength(1);
    });
  });

  describe('only ACTIVE listings are browsable', () => {
    it('excludes a draft', async () => {
      await seedListing({ title: 'live', owner: 'u1', publishedAt: new Date('2026-01-01') });
      await seedListing({ title: 'draft', owner: 'u1', publishedAt: new Date('2026-01-02'), status: 'draft' });
      const page = await searchListingsOffset(ALL, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['live']);
    });
  });

  describe('free-text search reads the generated vector', () => {
    it('matches stemmed prose and verbatim tags, and excludes a non-match', async () => {
      await seedListing({
        title: 'Running shoes',
        owner: 'u1',
        publishedAt: new Date('2026-01-01'),
        description: 'lightweight trainers',
      });
      await seedListing({
        title: 'Garden hose',
        owner: 'u1',
        publishedAt: new Date('2026-01-02'),
        tags: ['garden', 'watering'],
      });

      // Stemming: "run" matches "Running".
      expect((await searchListingsOffset({ q: 'run' }, 1, 10)).listings.map((l) => l.title)).toEqual([
        'Running shoes',
      ]);
      // A tag is stored as a VERBATIM lexeme, and matches when it is already
      // its own English stem.
      expect((await searchListingsOffset({ q: 'garden' }, 1, 10)).listings.map((l) => l.title)).toEqual([
        'Garden hose',
      ]);
      expect((await searchListingsOffset({ q: 'absentword' }, 1, 10)).listings).toHaveLength(0);
    });

    /**
     * A KNOWN LIMITATION, pinned so it is visible rather than discovered.
     *
     * The two halves of `listings.search_vector` are not symmetric:
     * `to_tsvector` STEMS the prose, `array_to_tsvector` stores each tag
     * verbatim — but `plainto_tsquery` stems the QUERY either way. Measured on
     * the server: the query `watering` becomes the lexeme `water`, the stored
     * tag stays `watering`, and they do not match; `garden` matches because it
     * is its own stem.
     *
     * So a tag is findable only when it is already an English stem. Mongo's
     * `$text` index stemmed tag values too, which makes this a small
     * FUNCTIONAL difference rather than a faithful port. Fixing it is a
     * generated-column change and therefore a migration, so it does not belong
     * to a read-path slice.
     *
     * **If this case goes red, the fix has probably landed** — confirm the
     * generated column now stems tags, then replace this with the positive
     * assertion rather than deleting it.
     */
    it('does NOT match a tag whose stem differs from the tag (known limitation)', async () => {
      await seedListing({
        title: 'Garden hose',
        owner: 'u1',
        publishedAt: new Date('2026-01-01'),
        tags: ['watering'],
      });
      expect((await searchListingsOffset({ q: 'watering' }, 1, 10)).listings).toHaveLength(0);
    });
  });

  describe('the geo radius filter', () => {
    it('returns listings inside the radius, nearest first, and excludes those outside', async () => {
      // Barcelona, ~1.5 km away, and Madrid (~500 km).
      await seedListing({ title: 'here', owner: 'u1', publishedAt: new Date('2026-01-01'), coords: { lng: 2.1734, lat: 41.3851 } });
      await seedListing({ title: 'nearby', owner: 'u1', publishedAt: new Date('2026-01-02'), coords: { lng: 2.1900, lat: 41.3851 } });
      await seedListing({ title: 'far', owner: 'u1', publishedAt: new Date('2026-01-03'), coords: { lng: -3.7038, lat: 40.4168 } });

      const page = await searchListingsOffset(
        { near: { lng: 2.1734, lat: 41.3851, radiusM: 5_000 } },
        1,
        10,
      );

      // Both halves: the far row proves the radius filters, the ORDER proves
      // the distance operator is doing the sorting.
      expect(page.listings.map((l) => l.title)).toEqual(['here', 'nearby']);
    });

    it('excludes a listing with no coordinates at all', async () => {
      await seedListing({ title: 'located', owner: 'u1', publishedAt: new Date('2026-01-01'), coords: { lng: 2.1734, lat: 41.3851 } });
      await seedListing({ title: 'nowhere', owner: 'u1', publishedAt: new Date('2026-01-02') });
      const page = await searchListingsOffset({ near: { lng: 2.1734, lat: 41.3851, radiusM: 5_000 } }, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['located']);
    });
  });

  describe('owner scoping', () => {
    it('returns one seller\'s listings and not another\'s', async () => {
      await seedListing({ title: 'mine', owner: 'seller-a', publishedAt: new Date('2026-01-01') });
      await seedListing({ title: 'theirs', owner: 'seller-b', publishedAt: new Date('2026-01-02') });

      const page = await listListingsForOwner({ ownerType: 'user', oxyUserId: 'seller-a' }, {}, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['mine']);
      expect(page.total).toBe(1);
    });

    it('includes a seller\'s own drafts, which the public browse excludes', async () => {
      await seedListing({ title: 'draft', owner: 'seller-a', publishedAt: null, status: 'draft' });
      const page = await listListingsForOwner({ ownerType: 'user', oxyUserId: 'seller-a' }, {}, 1, 10);
      expect(page.listings.map((l) => l.title)).toEqual(['draft']);
      expect((await searchListingsOffset(ALL, 1, 10)).listings).toHaveLength(0);
    });
  });

  describe('variants and categories', () => {
    it('returns no variants for an empty id list without querying', async () => {
      expect(await listVariantsForListings([])).toEqual([]);
    });

    it('lists only ACTIVE categories, ordered by position', async () => {
      await client()`
        INSERT INTO categories (id, name, slug, position, is_active)
        VALUES ('11111111-1111-7000-8000-000000000001', 'Second', 'second', 2, true),
               ('11111111-1111-7000-8000-000000000002', 'First', 'first', 1, true),
               ('11111111-1111-7000-8000-000000000003', 'Hidden', 'hidden', 0, false)`;

      const active = await listActiveCategories();
      expect(active.map((c) => c.slug)).toEqual(['first', 'second']);
      expect(await findCategoryBySlug('first')).not.toBeNull();
      expect(await findCategoryBySlug('missing')).toBeNull();
    });
  });
});

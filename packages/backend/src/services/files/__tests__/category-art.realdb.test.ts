/**
 * Category art import against a REAL Postgres server, with Oxy's importer
 * faked: a preview changes nothing, an apply points each category at the
 * Moovo-owned file Oxy imported (asking for the `category` reference in the
 * same request), and a category edited meanwhile is left alone with the stray
 * reference queued for removal.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { ApplicationFileImportBatchResult } from '@oxy.so/core';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { categories } from '../../../db/schema/catalog';
import { fileReferenceSyncs } from '../../../db/schema/files';
import {
  importCategoryArt,
  setCategoryArtImporterForTesting,
  type CategoryArtImporter,
} from '../category-art.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

type ImportItem = Parameters<CategoryArtImporter['importAppFiles']>[0][number];

function fakeImporter(onImport?: (items: ImportItem[]) => Promise<void>) {
  const calls: ImportItem[][] = [];
  const importer: CategoryArtImporter = {
    importAppFiles: async (items) => {
      calls.push(items);
      await onImport?.(items);
      return items.map((item, index): ApplicationFileImportBatchResult => {
        if (item.sourceUrl.includes('broken')) {
          return {
            index,
            ok: false,
            error: { status: 502, code: 'SOURCE_FETCH_FAILED', message: 'no' },
          };
        }
        return {
          index,
          ok: true,
          outcome: 'downloaded',
          deduplicated: false,
          source: { host: new URL(item.sourceUrl).host, fetchedAt: new Date().toISOString() },
          reference: { result: 'created' },
          file: {
            id: uuidv7(),
            sha256: 'a'.repeat(64),
            size: 1,
            mime: 'image/png',
            ext: 'png',
            ownerApplicationId: 'moovo',
            status: 'active',
            visibility: item.visibility,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
      });
    },
  };
  return { importer, calls };
}

describeIfPostgres('category art import on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterEach(async () => {
    setCategoryArtImporterForTesting();
    await requireSuite(suite).db.delete(categories);
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  const db = () => requireSuite(suite).db;

  async function category(imageUrl: string | null, imageFileId: string | null = null) {
    const slug = `c-${uuidv7()}`;
    await db().insert(categories).values({ name: slug, slug, imageUrl, imageFileId });
    return slug;
  }

  async function read(slug: string) {
    const [row] = await db().select().from(categories).where(eq(categories.slug, slug));
    return row;
  }

  it('previews by default: lists by host, never the URL, and calls nothing', async () => {
    const slug = await category('https://cdn.shop.example/art/boxes.png?sig=secret');
    await category(null);
    await category('https://cdn.shop.example/done.png', uuidv7());
    const { importer, calls } = fakeImporter();
    setCategoryArtImporterForTesting(importer);

    const report = await importCategoryArt({ apply: false });

    expect(report.dryRun).toBe(true);
    expect(report.candidates).toEqual([
      expect.objectContaining({ slug, sourceHost: 'cdn.shop.example' }),
    ]);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(calls).toEqual([]);
    expect((await read(slug))?.imageFileId).toBeNull();
  });

  it('imports as public Moovo files referenced by their category, and serves the file', async () => {
    const good = await category('https://cdn.shop.example/art/boxes.png');
    const broken = await category('https://cdn.shop.example/broken.png');
    const insecure = await category('http://cdn.shop.example/plain.png');
    const { importer, calls } = fakeImporter();
    setCategoryArtImporterForTesting(importer);

    const report = await importCategoryArt({ apply: true });

    const goodRow = await read(good);
    expect(goodRow?.imageFileId).toEqual(expect.any(String));
    expect(calls.flat()).toContainEqual({
      sourceUrl: 'https://cdn.shop.example/art/boxes.png',
      visibility: 'public',
      reference: { entityType: 'category', entityId: goodRow?.id },
    });
    expect(report.imported).toBe(1);
    expect(report.failed).toEqual([
      expect.objectContaining({ slug: broken, status: 502, code: 'SOURCE_FETCH_FAILED' }),
    ]);
    // Oxy fetches https only: not even asked.
    expect(report.invalid).toEqual([expect.objectContaining({ slug: insecure })]);
    expect(calls.flat().some((item) => item.sourceUrl.startsWith('http:'))).toBe(false);
    expect((await read(broken))?.imageFileId).toBeNull();

    // Idempotent: a category with art is never selected again.
    const again = await importCategoryArt({ apply: false });
    expect(again.candidates.map((c) => c.slug)).not.toContain(good);
  });

  it('leaves a category edited during the import alone, and queues the stray reference', async () => {
    const slug = await category('https://cdn.shop.example/art/old.png');
    const { importer } = fakeImporter(async () => {
      // An operator changes the source while Oxy is fetching the old one.
      await db()
        .update(categories)
        .set({ imageUrl: 'https://cdn.shop.example/art/new.png' })
        .where(eq(categories.slug, slug));
    });
    setCategoryArtImporterForTesting(importer);

    const report = await importCategoryArt({ apply: true });

    expect(report.superseded).toBe(1);
    const row = await read(slug);
    expect(row?.imageFileId).toBeNull();
    const queued = await db()
      .select()
      .from(fileReferenceSyncs)
      .where(eq(fileReferenceSyncs.entityId, row?.id ?? ''));
    expect(queued.map((q) => q.entityType)).toEqual(['category']);
  });
});

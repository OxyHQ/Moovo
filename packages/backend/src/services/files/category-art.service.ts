/**
 * Category art as files the MOOVO APPLICATION owns (oxy ADR 0043 D1, D7).
 *
 * Category art was hotlinked: `categories.image_url` held a seeded third-party
 * CDN URL and every client fetched it from that server. Category art belongs
 * to no person, so it becomes an Oxy file owned by Moovo itself, imported by
 * URL ONCE — Oxy fetches the source with its own SSRF-safe fetcher, stores it,
 * remembers the source (a repeat import of the same URL answers the existing
 * file without fetching) and registers Moovo's `category` reference in the same
 * request, so the file is never unreferenced long enough to be collected.
 *
 * `image_url` stays as the provenance of the art and is never served; the API
 * serves `image_file_id` only. Run by an operator through
 * `scripts/import-category-art.ts` — a preview by default, `--apply` to write.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ApplicationFileImportBatchResult, FileVisibility } from '@oxy.so/core';
import { oxyClient } from '../../middleware/auth.js';
import { getDb } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';

export interface CategoryArtImporter {
  importAppFiles(
    items: Array<{
      sourceUrl: string;
      visibility: FileVisibility;
      reference?: { entityType: string; entityId: string };
    }>,
  ): Promise<ApplicationFileImportBatchResult[]>;
}

let importer: () => CategoryArtImporter = () => oxyClient.assets;

/** Test seam: replace Oxy's importer. Pass nothing to restore it. */
export function setCategoryArtImporterForTesting(next?: CategoryArtImporter): void {
  importer = next ? () => next : () => oxyClient.assets;
}

/** One category whose art is still only a URL. Never carries the URL itself. */
export interface CategoryArtCandidate {
  categoryId: string;
  slug: string;
  /** The source's host — enough to review a plan without printing URLs. */
  sourceHost: string | null;
}

export interface CategoryArtReport {
  dryRun: boolean;
  /** Categories that would be (or were) imported. */
  candidates: CategoryArtCandidate[];
  /** Imported and stored on the category. */
  imported: number;
  /** Imported, but the category changed meanwhile (art set or source edited); left alone. */
  superseded: number;
  /** Not importable as given: not an absolute `https` URL. Oxy fetches https only. */
  invalid: CategoryArtCandidate[];
  /** Oxy refused or could not fetch the source. */
  failed: Array<CategoryArtCandidate & { status: number; code: string }>;
}

function httpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

/** Preview, or with `apply`, import every category's art that is still only a URL. */
export async function importCategoryArt(options: { apply: boolean }): Promise<CategoryArtReport> {
  const db = getDb();
  const rows = await db
    .select({ id: categories.id, slug: categories.slug, imageUrl: categories.imageUrl })
    .from(categories)
    .where(and(isNull(categories.imageFileId), isNotNull(categories.imageUrl)))
    .orderBy(categories.id);

  const report: CategoryArtReport = {
    dryRun: !options.apply,
    candidates: [],
    imported: 0,
    superseded: 0,
    invalid: [],
    failed: [],
  };
  const importable: Array<CategoryArtCandidate & { sourceUrl: string }> = [];
  for (const row of rows) {
    const sourceUrl = row.imageUrl ?? '';
    const candidate = { categoryId: row.id, slug: row.slug, sourceHost: httpsHost(sourceUrl) };
    if (candidate.sourceHost === null) {
      report.invalid.push(candidate);
      continue;
    }
    report.candidates.push(candidate);
    importable.push({ ...candidate, sourceUrl });
  }
  if (!options.apply || importable.length === 0) return report;

  const results = await importer().importAppFiles(
    importable.map((item) => ({
      sourceUrl: item.sourceUrl,
      visibility: 'public',
      reference: { entityType: 'category', entityId: item.categoryId },
    })),
  );

  for (const result of results) {
    const item = importable[result.index];
    if (!item) continue;
    const { sourceUrl, ...candidate } = item;
    if ('error' in result) {
      report.failed.push({ ...candidate, status: result.error.status, code: result.error.code });
      continue;
    }
    // Only a category still waiting for THIS source: an operator who set art
    // or edited the source meanwhile wins. The import registered a `category`
    // reference that row does not use, so it is enqueued for a re-check, which
    // removes it; the file, then used by nothing, is collected by Oxy.
    const updated = await db
      .update(categories)
      .set({ imageFileId: result.file.id })
      .where(
        and(
          eq(categories.id, item.categoryId),
          isNull(categories.imageFileId),
          eq(categories.imageUrl, sourceUrl),
        ),
      );
    if ((updated.count ?? 0) === 1) {
      report.imported += 1;
    } else {
      report.superseded += 1;
      await db.execute(
        sql`select moovo_enqueue_file_reference_syncs('category', ${item.categoryId}, array[${result.file.id}]::text[])`,
      );
    }
  }
  return report;
}

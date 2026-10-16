/**
 * THE media chokepoint.
 *
 * A value is an Oxy file id or it is nothing: it resolves through the SDK's
 * `assets.publicUrl` — the only sanctioned resolver — and anything that cannot
 * be a file id (a URL above all) resolves to `undefined`. Do NOT build another
 * resolver, and do not hardcode `cloud.oxy.so` anywhere.
 *
 * ## Why an absolute URL is refused rather than passed through
 *
 * It used to be returned as-is ("seeded CDN assets pass through unchanged").
 * That made every `fileId` field an open hotlink: a listing created with
 * `imageFileIds: ['https://tracker.example/pixel.gif']` had every viewer's
 * client fetch a stranger's server, and the seeded category art kept depending
 * on a third party's uptime and goodwill. Under oxy ADR 0043 an image Moovo
 * shows is an Oxy file — the user's own, ownership-checked at write
 * (`files/file-ownership.ts`), or the Moovo application's, imported once by URL
 * (`scripts/import-category-art.ts`). `OXY_FILE_ID_PATTERN` is the same test
 * `moovo_entity_file_ids()` applies in SQL (migration 0011).
 *
 * ## Why this is its own module
 *
 * It used to live in `catalog-hydration.service.ts`, which loads the
 * marketplace catalogue (`ProductVariant`, `SellerProfile`, `Store`) at module
 * scope. Resolving a file id has nothing to do with any of them, but three
 * COURIER services — `courier-hydration`, `job-hydration` and
 * `shipment-hydration` — call it, so every one of them transitively loaded
 * three marketplace models to turn a string into a URL. A courier profile's
 * avatar and a delivery's proof-of-delivery photo are not catalogue concerns.
 *
 * The rule it enforces is shared by both halves of the product, which is
 * exactly why it belongs to neither. A scanned test used to fail the build if a
 * courier hydration service could reach a marketplace model again; it was
 * retired with `src/models/` itself, which enforces the same thing by leaving
 * nothing to reach. Keep this module free of catalogue imports so that stays
 * true of whatever replaces the marketplace scaffolding.
 */

import { oxyClient } from '../middleware/auth.js';

/**
 * What an Oxy file id can look like: Oxy's reference routes accept at most 64
 * characters, and no id carries a scheme, a slash or whitespace. The same
 * expression gates `moovo_entity_file_ids()` in migration 0011.
 */
export const OXY_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isOxyFileId(value: unknown): value is string {
  return typeof value === 'string' && OXY_FILE_ID_PATTERN.test(value);
}

/** The public URL of an Oxy file, or `undefined` for a value that is not one. */
export function resolveMedia(fileId: string, variant?: string): string | undefined {
  if (!isOxyFileId(fileId)) return undefined;
  return oxyClient.assets.publicUrl(fileId, variant);
}

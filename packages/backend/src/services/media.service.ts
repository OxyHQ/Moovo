/**
 * THE media chokepoint.
 *
 * Absolute URLs are returned as-is (seeded CDN assets pass through unchanged);
 * anything else is treated as an Oxy media file id and resolved through the
 * SDK's `getFileDownloadUrl` — the only sanctioned resolver. Do NOT build
 * another, and do not hardcode `cloud.oxy.so` anywhere.
 *
 * ## Why this is its own module
 *
 * It used to live in `catalog-hydration.service.ts`, which imports the
 * `ProductVariant`, `SellerProfile` and `Store` Mongoose models at module
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

/** Matches an absolute http(s) URL (seeded CDN assets pass through unchanged). */
const ABSOLUTE_URL = /^https?:\/\//i;

export function resolveMedia(value: string, variant?: string): string {
  if (ABSOLUTE_URL.test(value)) {
    return value;
  }
  return oxyClient.getFileDownloadUrl(value, variant);
}

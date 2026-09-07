/**
 * Tracking adapter registry.
 *
 * The single lookup from a carrier `key` to its {@link TrackingAdapter}.
 * Adapters self-register at boot via `registerBuiltInTrackingAdapters` (called
 * from `index.ts`). Nothing outside an adapter branches on which carrier it is.
 *
 * Deliberately a SECOND registry rather than an extension of
 * `services/providers/provider-registry.ts`: that one is enumerated by
 * `quote.service.ts` to price a shipment, so a carrier landing in it becomes an
 * option in a customer's checkout. The populations are different by design —
 * bookable is a handful, trackable is hundreds.
 */

import type { TrackingAdapter } from './tracking-adapter.js';
import { log } from '../../lib/logger.js';

const adapters = new Map<string, TrackingAdapter>();

/** Register an adapter under its `key` (replacing any prior adapter for that key). */
export function registerTrackingAdapter(adapter: TrackingAdapter): void {
  if (adapters.has(adapter.key)) {
    log.general.warn({ key: adapter.key }, 'Replacing already-registered tracking adapter');
  }
  adapters.set(adapter.key, adapter);
}

/** Resolve the adapter for `key`, or `undefined` when none is registered. */
export function getTrackingAdapter(key: string): TrackingAdapter | undefined {
  return adapters.get(key);
}

/** Every registered adapter (in insertion order). */
export function listTrackingAdapters(): TrackingAdapter[] {
  return [...adapters.values()];
}

/**
 * Adapters that can actually be called.
 *
 * `config.tracking.enabled` requires this to be non-empty: a poller with no
 * fetching adapter is a timer that claims rows and fails every one of them into
 * backoff, which looks from the outside like every carrier being down at once.
 */
export function listFetchingTrackingAdapters(): TrackingAdapter[] {
  return listTrackingAdapters().filter((adapter) => adapter.capabilities.fetch);
}

/** Clear the registry. Intended for tests so each case starts from a clean slate. */
export function __resetTrackingRegistryForTests(): void {
  adapters.clear();
}

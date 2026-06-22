/**
 * Provider adapter registry.
 *
 * The single lookup table from a provider `key` to its {@link ProviderAdapter}.
 * Adapters self-register at boot via `registerBuiltInAdapters` (called from
 * `index.ts`). The quote/job services resolve adapters through `getAdapter` only —
 * there is no per-provider branching outside the adapters themselves.
 */

import type { ProviderAdapter } from './provider-adapter.js';
import { log } from '../../lib/logger.js';

/** The key→adapter table, populated once at boot. */
const adapters = new Map<string, ProviderAdapter>();

/** Register an adapter under its `key` (replacing any prior adapter for that key). */
export function registerAdapter(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.key)) {
    log.general.warn({ key: adapter.key }, 'Replacing already-registered provider adapter');
  }
  adapters.set(adapter.key, adapter);
}

/** Resolve the adapter for `key`, or `undefined` when none is registered. */
export function getAdapter(key: string): ProviderAdapter | undefined {
  return adapters.get(key);
}

/** Every registered adapter (in insertion order). */
export function listAdapters(): ProviderAdapter[] {
  return [...adapters.values()];
}

/** Clear the registry. Intended for tests so each case starts from a clean slate. */
export function __resetRegistryForTests(): void {
  adapters.clear();
}

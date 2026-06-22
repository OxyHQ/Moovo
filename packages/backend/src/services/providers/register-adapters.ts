/**
 * Built-in adapter registration.
 *
 * Called once at boot (from `index.ts`'s `connectDB().then(...)` block) to
 * populate the provider registry with the adapters shipped in this build. New
 * carrier integrations register their adapter here — nowhere else needs to know
 * which adapters exist.
 */

import { registerAdapter } from './provider-registry.js';
import { buildMockAdapters } from './adapters/mock-provider.js';
import { log } from '../../lib/logger.js';

/** Register every built-in provider adapter into the registry. */
export function registerBuiltInAdapters(): void {
  const adapters = buildMockAdapters();
  for (const adapter of adapters) {
    registerAdapter(adapter);
  }
  log.general.info({ count: adapters.length, keys: adapters.map((a) => a.key) }, 'Registered built-in provider adapters');
}

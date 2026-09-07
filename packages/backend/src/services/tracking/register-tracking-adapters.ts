/**
 * Built-in tracking adapter registration.
 *
 * Called once at boot from `index.ts`, beside `registerBuiltInAdapters()`. New
 * carriers are added to `adapters/built-in-carriers.ts` — nowhere else needs to
 * know which carriers exist.
 */

import { registerTrackingAdapter, listFetchingTrackingAdapters } from './tracking-registry.js';
import { BUILT_IN_TRACKING_CARRIERS } from './adapters/built-in-carriers.js';
import { log } from '../../lib/logger.js';

export function registerBuiltInTrackingAdapters(): void {
  for (const carrier of BUILT_IN_TRACKING_CARRIERS) {
    registerTrackingAdapter(carrier.adapter);
  }
  const fetching = listFetchingTrackingAdapters();
  log.general.info(
    {
      count: BUILT_IN_TRACKING_CARRIERS.length,
      fetching: fetching.length,
      keys: BUILT_IN_TRACKING_CARRIERS.map((carrier) => carrier.adapter.key),
    },
    'Registered built-in tracking adapters',
  );
}

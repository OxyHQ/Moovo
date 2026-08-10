/**
 * Provider seeding (idempotent).
 *
 * Upserts an enabled `Provider` doc per built-in mock carrier (keyed by `key`)
 * so the quote fan-out has enabled external providers to call at boot. Run once
 * from `index.ts`'s startup block; safe to run repeatedly — an existing provider
 * is left in place (only created when absent) so a deploy never clobbers
 * operator edits to `enabled`/`supportedCountries`/`config`.
 */

import { insertProviderIfAbsent } from '../../db/transport/providerRepository.js';
import { MOCK_CARRIERS } from './adapters/mock-provider.js';
import type { ShipmentType } from '@moovo/shared-types';
import { log } from '../../lib/logger.js';

/** Shipment types the mock carriers can fulfil (parcels of all sizes). */
const MOCK_SUPPORTED_TYPES: ShipmentType[] = ['package'];

/**
 * Idempotently seed an enabled provider per mock carrier. Returns how many docs
 * were newly created (0 on a warm boot where they already exist).
 */
export async function seedProviders(): Promise<number> {
  let created = 0;
  for (const carrier of MOCK_CARRIERS) {
    // `DO NOTHING`, the port of `$setOnInsert` alone: an existing provider is
    // left EXACTLY as it stands, so a deploy never clobbers operator edits to
    // `enabled`/`supportedCountries`/`config`. A `DO UPDATE` here would reset
    // all three on every boot, and the operator's change would revert itself
    // hours later with nothing in the logs.
    if (
      await insertProviderIfAbsent({
        key: carrier.key,
        name: carrier.name,
        enabled: true,
        supportedTypes: MOCK_SUPPORTED_TYPES,
        supportedCountries: [],
        config: {},
      })
    ) {
      created += 1;
    }
  }
  log.general.info({ created, total: MOCK_CARRIERS.length }, 'Seeded provider docs (idempotent)');
  return created;
}

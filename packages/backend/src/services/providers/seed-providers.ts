/**
 * Provider seeding (idempotent).
 *
 * Upserts an enabled `Provider` doc per built-in mock carrier (keyed by `key`)
 * so the quote fan-out has enabled external providers to call at boot. Run once
 * from `index.ts`'s startup block; safe to run repeatedly — an existing provider
 * is left in place (only created when absent) so a deploy never clobbers
 * operator edits to `enabled`/`supportedCountries`/`config`.
 */

import { Provider } from '../../models/provider.js';
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
    const result = await Provider.updateOne(
      { key: carrier.key },
      {
        $setOnInsert: {
          key: carrier.key,
          name: carrier.name,
          enabled: true,
          supportedTypes: MOCK_SUPPORTED_TYPES,
          supportedCountries: [],
          config: {},
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount && result.upsertedCount > 0) {
      created += result.upsertedCount;
    }
  }
  log.general.info({ created, total: MOCK_CARRIERS.length }, 'Seeded provider docs (idempotent)');
  return created;
}

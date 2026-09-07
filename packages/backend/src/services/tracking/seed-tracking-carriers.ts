/**
 * Tracking carrier seeding (idempotent).
 *
 * Creates one `tracking_carriers` row per built-in carrier so the catalogue
 * endpoint and the detector's country ranking have something to read.
 *
 * `DO NOTHING`, never `DO UPDATE`, and the reason is the same one
 * `seed-providers.ts` states: every column here is operator-editable —
 * `enabled`, `source_kind`, the rate budget, and above all
 * `deep_link_template`, which is the field somebody fixes at 9am when a carrier
 * reorganises its website. A `DO UPDATE` would revert that fix on the next
 * deploy, hours later, with nothing in the logs connecting the two.
 */

import { insertTrackingCarrierIfAbsent } from '../../db/tracking/trackingCarrierRepository.js';
import { BUILT_IN_TRACKING_CARRIERS } from './adapters/built-in-carriers.js';
import { deepLinkTemplate } from './adapters/deeplink-carrier.js';
import { log } from '../../lib/logger.js';

export async function seedTrackingCarriers(): Promise<number> {
  let created = 0;
  for (const carrier of BUILT_IN_TRACKING_CARRIERS) {
    const capabilities = carrier.adapter.capabilities;
    if (
      await insertTrackingCarrierIfAbsent({
        key: carrier.adapter.key,
        name: carrier.name,
        // `deep_link_only` until a carrier has a real feed AND somebody has
        // approved how we read it. `public_page` in particular is a legal
        // decision per carrier, never a side effect of shipping an adapter.
        sourceKind: capabilities.deepLinkOnly ? 'deep_link_only' : 'official_api',
        pollSupported: capabilities.fetch,
        webhookSupported: capabilities.webhook,
        deepLinkTemplate: deepLinkTemplate(carrier.adapter),
        countryCodes: carrier.countryCodes,
      })
    ) {
      created += 1;
    }
  }
  log.general.info(
    { created, total: BUILT_IN_TRACKING_CARRIERS.length },
    'Seeded tracking carriers (idempotent)',
  );
  return created;
}

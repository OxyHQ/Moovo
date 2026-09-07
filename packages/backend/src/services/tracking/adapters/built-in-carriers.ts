/**
 * The carriers this build knows about, and how each one is recognised.
 *
 * **Every one of them is deep-link-only today.** Detection, naming and linking
 * out all work end to end; none has a live feed yet, so `config.tracking.enabled`
 * stays off and the poller has nothing to claim. Giving one a feed is adding
 * `fetch` to its object and flipping `poll_supported` on its row.
 *
 * That ordering is deliberate rather than a shortcut. A real carrier client is
 * an HTTP contract with a response shape that has to be confirmed against the
 * live API and pinned with recorded fixtures — written from memory it looks
 * finished, type-checks, passes its own mocks, and returns nothing a carrier
 * ever sends. The seam is verifiable now; the clients are verifiable only with
 * credentials, so they land per carrier, each with its own fixtures.
 */

import type { TrackingAdapter, TrackingDetectionHint } from '../tracking-adapter.js';
import { buildDeepLinkAdapter } from './deeplink-carrier.js';
import { s10CheckDigitValid, upsCheckDigitValid } from '../carrier-detection.js';

/** A confident claim: the shape matched AND the check digit agreed. */
const CHECKSUM_MATCH: TrackingDetectionHint = { checksumPassed: true, score: 100 };
/** The shape matched and there is no check digit we can verify. */
const shapeMatch = (score: number): TrackingDetectionHint => ({ checksumPassed: false, score });

/**
 * UPU S10, the international postal standard: two letters, nine digits, then
 * the ISO country of the ORIGIN operator.
 *
 * One rule covers essentially every national post, which is why the country
 * suffix selects the carrier rather than each operator carrying its own regex.
 */
function s10Detect(country: string) {
  const pattern = new RegExp(`^[A-Z]{2}\\d{9}${country}$`);
  return (normalised: string): TrackingDetectionHint | null => {
    if (!pattern.test(normalised)) return null;
    return s10CheckDigitValid(normalised) ? CHECKSUM_MATCH : shapeMatch(60);
  };
}

/**
 * The carriers, in no particular order — ranking is computed per number, not
 * declared here.
 *
 * `name` and `countryCodes` are seed values for `tracking_carriers`; the row is
 * authoritative afterwards and an operator may edit either.
 */
export interface BuiltInCarrier {
  adapter: TrackingAdapter;
  name: string;
  countryCodes: string[];
}

export const BUILT_IN_TRACKING_CARRIERS: readonly BuiltInCarrier[] = [
  {
    name: 'UPS',
    countryCodes: ['US', 'ES', 'GB', 'DE', 'FR'],
    adapter: buildDeepLinkAdapter({
      key: 'ups',
      template: 'https://www.ups.com/track?tracknum={number}',
      // The one carrier whose own check digit is implemented, so a `1Z` number
      // is identified rather than guessed at.
      detect: (normalised) => {
        if (!/^1Z[0-9A-Z]{16}$/.test(normalised)) return null;
        return upsCheckDigitValid(normalised) ? CHECKSUM_MATCH : shapeMatch(50);
      },
    }),
  },
  {
    name: 'DHL Express',
    countryCodes: ['DE', 'ES', 'GB', 'FR', 'US'],
    adapter: buildDeepLinkAdapter({
      key: 'dhl-express',
      template: 'https://www.dhl.com/es-es/home/tracking.html?tracking-id={number}',
      // Ten digits, or the JJD/JVGL air-waybill prefixes. The DHL check digit
      // is NOT implemented, so this reports a shape match and never breaks a
      // tie on its own — see the header of `carrier-detection.ts` for why that
      // is the safe direction to be wrong in.
      detect: (normalised) => {
        if (/^\d{10}$/.test(normalised)) return shapeMatch(40);
        if (/^(JJD|JVGL)[0-9A-Z]{10,20}$/.test(normalised)) return shapeMatch(70);
        return null;
      },
    }),
  },
  {
    name: 'FedEx',
    countryCodes: ['US', 'ES', 'GB', 'DE', 'FR'],
    adapter: buildDeepLinkAdapter({
      key: 'fedex',
      template: 'https://www.fedex.com/fedextrack/?trknbr={number}',
      // 12, 15, 20 or 22 digits. Check digit not implemented; shape only.
      detect: (normalised) =>
        /^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(normalised) ? shapeMatch(35) : null,
    }),
  },
  {
    name: 'Correos',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'correos',
      template:
        'https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number={number}',
      detect: (normalised) => {
        const s10 = s10Detect('ES')(normalised);
        if (s10) return s10;
        // Correos' own domestic format, which is not S10.
        return /^(PQ|CP|CD)\d{9}[A-Z]{0,2}$/.test(normalised) ? shapeMatch(65) : null;
      },
    }),
  },
  {
    name: 'Royal Mail',
    countryCodes: ['GB'],
    adapter: buildDeepLinkAdapter({
      key: 'royal-mail',
      template: 'https://www.royalmail.com/track-your-item#/tracking-results/{number}',
      detect: s10Detect('GB'),
    }),
  },
  {
    name: 'Deutsche Post',
    countryCodes: ['DE'],
    adapter: buildDeepLinkAdapter({
      key: 'deutsche-post',
      template: 'https://www.deutschepost.de/sendung/simpleQueryResult.html?form.sendungsnummer={number}',
      detect: s10Detect('DE'),
    }),
  },
  {
    name: 'SEUR',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'seur',
      template: 'https://www.seur.com/livetracking/?segOnlineIdentificador={number}',
      // No published structure worth matching on: SEUR references collide with
      // too much else, so the user picks it. Detection that fires on everything
      // is worse than none — it would make every number ambiguous.
    }),
  },
  {
    name: 'GLS',
    countryCodes: ['ES', 'DE', 'FR'],
    adapter: buildDeepLinkAdapter({
      key: 'gls',
      template: 'https://gls-group.com/track/{number}',
    }),
  },
  {
    name: 'Amazon Logistics',
    countryCodes: ['ES', 'GB', 'DE', 'FR', 'US'],
    adapter: buildDeepLinkAdapter({
      key: 'amazon',
      // Amazon has no public tracking surface keyed on a number alone — the
      // link goes to the customer's own orders page. Honest, and better than
      // pretending we can resolve it.
      template: 'https://www.amazon.es/gp/css/order-history',
    }),
  },
  {
    name: 'Moovo',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'moovo',
      // The internal pointer carrier. A parcel on this key carries `moovoJobId`
      // and ZERO checkpoints for its whole life; the detail endpoint hydrates
      // the job instead. It is never fetched and never detected from a number —
      // a Moovo parcel is created by booking, not by pasting.
      template: 'https://tracker.moovo.now/track/{number}',
    }),
  },
];

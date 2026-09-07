/**
 * The carriers this build knows about, and how each one is recognised.
 *
 * ## Coverage is cheap; DETECTION is not, and they are separate decisions
 *
 * Adding a carrier costs one entry. Adding a `detect` costs correctness, because
 * `resolveDetection` is decisive only when ONE carrier claims a number or when
 * exactly one claimant passes a check digit. Every extra shape-only rule that
 * overlaps an existing one turns a number that used to resolve into a question.
 *
 * So most of the Spanish carriers below carry NO `detect`. Their references are
 * bare 8-to-14-digit runs that collide with each other, with Correos' domestic
 * format and with FedEx — a rule for each would make every numeric Spanish
 * parcel ambiguous, which is a worse product than the picker. They are here to
 * be NAMED and LINKED, which is the whole difference between "we don't know what
 * this is" and "this is a Nacex parcel, here it is on Nacex".
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
import { buildFedexAdapter } from './fedex.js';
import { config } from '../../../config/index.js';
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
    // The ONE carrier here that can have a real feed. It is deep-link-only
    // unless `FEDEX_CLIENT_ID` and `FEDEX_CLIENT_SECRET` are both set, so this
    // entry is unchanged in every deploy that has not been given credentials.
    // Detection (12/15/20/22 digits, shape only) is identical either way.
    adapter: buildFedexAdapter(config.tracking.fedex ?? null),
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
    name: 'USPS',
    countryCodes: ['US'],
    adapter: buildDeepLinkAdapter({
      key: 'usps',
      template: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={number}',
      // Two real shapes. IMpb labels start 92/93/94/95 and run 20, 22 or 26
      // digits; international mail is S10 with a US origin suffix.
      //
      // The IMpb MOD-10 check digit is NOT implemented, so this reports a shape
      // match. That is the safe direction and it is the same call FedEx and DHL
      // already make here: `checksumPassed` is what breaks a tie, so a checksum
      // that is wrong in the optimistic direction auto-picks the wrong carrier,
      // while one that is merely absent asks a question.
      //
      // It DOES overlap FedEx's `\d{20}`/`\d{22}` rule, and that overlap is an
      // improvement rather than a regression: a `9405…` number is USPS, and
      // before this entry existed FedEx was the only claimant and it was picked
      // SILENTLY. Two claimants and a question beats one claimant and a wrong
      // answer — the parcel that shows "no information" forever is the failure
      // this file is organised to avoid.
      detect: (normalised) => {
        const s10 = s10Detect('US')(normalised);
        if (s10) return s10;
        return /^9[2345](\d{18}|\d{20}|\d{24})$/.test(normalised) ? shapeMatch(80) : null;
      },
    }),
  },
  {
    name: 'DHL eCommerce',
    countryCodes: ['US', 'DE', 'ES', 'GB'],
    adapter: buildDeepLinkAdapter({
      key: 'dhl-ecommerce',
      template: 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html?tracking-id={number}',
      // No rule: DHL eCommerce reuses `GM`/`LX` prefixes and bare digit runs
      // that collide with DHL Express' own, and splitting a number between two
      // DHL adapters by guesswork helps nobody. The user picks.
    }),
  },
  {
    name: 'OnTrac',
    countryCodes: ['US'],
    adapter: buildDeepLinkAdapter({
      key: 'ontrac',
      template: 'https://www.ontrac.com/tracking/?number={number}',
      // A single letter then fourteen digits — distinctive enough that no other
      // carrier here claims it.
      detect: (normalised) => (/^[CD]\d{14}$/.test(normalised) ? shapeMatch(75) : null),
    }),
  },
  {
    name: 'Veho',
    countryCodes: ['US'],
    adapter: buildDeepLinkAdapter({
      key: 'veho',
      template: 'https://track.shipveho.com/{number}',
      // The `1LS` prefix is LaserShip's, which Veho absorbed. Kept because the
      // labels are still in circulation and nothing else claims that prefix.
      detect: (normalised) => (/^1LS[0-9A-Z]{6,}$/.test(normalised) ? shapeMatch(75) : null),
    }),
  },
  {
    name: 'Correos Express',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'correos-express',
      template: 'https://www.correosexpress.com/web/correosexpress/detalle-envio?n={number}',
    }),
  },
  {
    name: 'MRW',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'mrw',
      template: 'https://www.mrw.es/seguimiento_envios/MRW_historico_estados.asp?envio={number}',
    }),
  },
  {
    name: 'Nacex',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'nacex',
      template: 'https://www.nacex.es/seguimientoDetalle.do?agencia_origen=&numero_albaran={number}',
    }),
  },
  {
    name: 'CTT Express',
    countryCodes: ['ES', 'PT'],
    adapter: buildDeepLinkAdapter({
      key: 'ctt-express',
      template: 'https://www.cttexpress.com/localizador-de-envios/?sc={number}',
    }),
  },
  {
    name: 'DHL Parcel',
    countryCodes: ['ES', 'PT'],
    adapter: buildDeepLinkAdapter({
      key: 'dhl-parcel',
      template: 'https://www.dhl.com/es-es/home/tracking/tracking-parcel.html?tracking-id={number}',
    }),
  },
  {
    name: 'Paack',
    countryCodes: ['ES', 'PT', 'GB'],
    adapter: buildDeepLinkAdapter({
      key: 'paack',
      template: 'https://track.paack.co/{number}',
    }),
  },
  {
    name: 'Envialia',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'envialia',
      template: 'https://www.envialia.com/seguimiento-envio/?ex={number}',
    }),
  },
  {
    name: 'Tipsa',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'tipsa',
      template: 'https://www.tip-sa.com/seguimiento-de-envios?codigo={number}',
    }),
  },
  {
    name: 'Zeleris',
    countryCodes: ['ES'],
    adapter: buildDeepLinkAdapter({
      key: 'zeleris',
      template: 'https://www.zeleris.com/seguimiento-de-envios/?envio={number}',
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

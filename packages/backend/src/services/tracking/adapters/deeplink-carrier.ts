/**
 * The factory that makes coverage cheap.
 *
 * A carrier with no reachable feed is still worth knowing about: we can detect
 * that a number is theirs, name them in the UI, and send the user to their page.
 * That is the difference between "we don't know what this is" and "this is a
 * GLS parcel, here it is on GLS" — and it costs one entry in a list.
 *
 * Every adapter built here has no `fetch`, so `tracked_parcels.poll_mode` is
 * `deeplink` and `tracked_parcels_deeplink_no_poll_check` makes it impossible
 * for the poller to schedule one. Giving a carrier a real feed later is adding
 * `fetch` to its object and changing its seeded row — no table, interface or
 * call-site change anywhere.
 *
 * ## The template lives in the DATABASE; this is only the seed value
 *
 * `deepLink()` here is what `seed-tracking-carriers.ts` writes into
 * `tracking_carriers.deep_link_template` the first time a carrier appears, and
 * the fallback if a row is somehow missing. Runtime reads the COLUMN. Carriers
 * reorganise their websites without warning, and a broken link has to be
 * fixable by an operator in one UPDATE rather than by a deploy.
 */

import type {
  TrackingAdapter,
  TrackingCapabilities,
  TrackingDetectionHint,
} from '../tracking-adapter.js';

const DEEP_LINK_ONLY: TrackingCapabilities = Object.freeze({
  fetch: false,
  webhook: false,
  deepLinkOnly: true,
});

export interface DeepLinkCarrierSpec {
  key: string;
  /** `{number}` is substituted with the normalised tracking number. */
  template: string;
  /**
   * Claims a normalised number as this carrier's, or returns `null`.
   *
   * Omitted for a carrier that can never be detected from the number alone
   * (Amazon and most marketplaces), which the user picks by hand.
   */
  detect?: (normalised: string) => TrackingDetectionHint | null;
}

export function buildDeepLinkAdapter(spec: DeepLinkCarrierSpec): TrackingAdapter {
  return {
    key: spec.key,
    capabilities: DEEP_LINK_ONLY,
    detect: spec.detect,
    deepLink: ({ trackingNumber }) =>
      spec.template.replace('{number}', encodeURIComponent(trackingNumber)),
  };
}

/** The seed value for a carrier's `deep_link_template` column. */
export function deepLinkTemplate(adapter: TrackingAdapter): string {
  return adapter.deepLink({ trackingNumber: '{number}' }).replace('%7Bnumber%7D', '{number}');
}

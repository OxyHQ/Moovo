/**
 * The tracking adapter contract — one carrier, one object.
 *
 * ## Why this is not `ProviderAdapter`
 *
 * `ProviderAdapter` (in `services/providers/`) is the contract for a carrier
 * Moovo can HAND A SHIPMENT TO, and it is the wrong shape here for four
 * reasons, in order of how expensive each is to get wrong:
 *
 * 1. **The keys are different objects.** `ProviderAdapter.track(bookingRef)` is
 *    keyed on a booking MOOVO MADE. A tracked parcel has no booking — the key
 *    is a bare number a stranger pasted. Widening `track` to accept both makes
 *    every adapter branch on which one it got.
 * 2. **`quote` and `book` would be stubs that throw.** Correos and Royal Mail
 *    will never price for Moovo. Worse, `quote.service.ts` fans out over every
 *    registered provider adapter, so a throwing `quote` is a failed quote in a
 *    customer's checkout.
 * 3. **`ProviderTracking.status` is a `JobStatus`**, which is a dispatch-auction
 *    vocabulary with no `out_for_delivery` and no `exception`. See
 *    `@moovo/shared-types`'s `tracking.ts` for the argument in full.
 * 4. **The registries are populated for different reasons.** `seed-providers.ts`
 *    seeds what Moovo can book; the tracker seeds everything it can detect.
 *
 * Where a carrier is both (DHL), it gets one of each, linked by
 * `tracking_carriers.provider_id`. Two objects on purpose: different
 * credentials, different endpoints, different rate budgets.
 *
 * ## `fetch` is optional, and that is how a deep-link carrier is expressed
 *
 * A carrier with no reachable feed has no `fetch`, `capabilities.deepLinkOnly`,
 * and a `tracking_carriers.poll_mode` of `deeplink` — at which point
 * `tracked_parcels_deeplink_no_poll_check` makes it impossible for the poller to
 * schedule one of its parcels. Not a null object, not a stub that throws, and
 * not a convention: the database refuses the state.
 *
 * It is also what keeps a future scraping or aggregator adapter from touching
 * this file. Adding one is implementing `fetch` on an adapter object and
 * flipping a column — no table change, no interface change, no call site.
 */

import type { GeoPoint, TrackingStatus } from '@moovo/shared-types';

/** What an adapter can actually do, as facts rather than as thrown errors. */
export interface TrackingCapabilities {
  /** Can we call this carrier for a snapshot? Implies `fetch` is present. */
  fetch: boolean;
  /** Does this carrier push to us? Implies `parseWebhook` and `verifyWebhook`. */
  webhook: boolean;
  /** No reachable feed: we hold the number and send the user to the carrier. */
  deepLinkOnly: boolean;
}

/** One scan event, as an adapter reports it before it becomes a row. */
export interface TrackingCheckpointInput {
  occurredAt: Date;
  /**
   * The carrier reported wall-clock time with no offset, so `occurredAt` is
   * that local time rather than a true instant. Report the fact; never invent
   * an offset to make it look like one.
   */
  occurredAtIsLocal?: boolean;
  status: TrackingStatus;
  rawStatus?: string;
  description?: string;
  locationText?: string;
  countryCode?: string;
  location?: GeoPoint;
}

/** Everything one successful fetch learned. */
export interface TrackingSnapshot {
  status: TrackingStatus;
  rawStatus?: string;
  /**
   * The whole history the carrier returned, not just what is new. Deduplication
   * is the repository's job (`tracking_checkpoints.dedupe_key`), because an
   * adapter cannot know what Moovo already stored.
   */
  checkpoints: TrackingCheckpointInput[];
  estimatedDeliveryAt?: Date;
  deliveredAt?: Date;
  serviceName?: string;
  originCountry?: string;
  destinationCountry?: string;
  /**
   * The carrier says this number does not exist.
   *
   * NOT an error, and the distinction is load-bearing: a label created and
   * never scanned is the single most common thing anyone pastes into a tracker.
   * Treated as a failure it would enter error backoff and stay there; treated
   * as this, it expires. See `tracking-cadence.ts`.
   */
  notFound?: boolean;
}

/** What an adapter needs in order to ask. */
export interface TrackingFetchInput {
  /** Already normalised by `normalizeTrackingNumber`. */
  trackingNumber: string;
  /** Correos and Royal Mail require it as a second factor. */
  destinationPostalCode?: string;
  destinationCountry?: string;
  /**
   * The POLLER owns the timeout, not the adapter — so a whole batch can be
   * cancelled at shutdown rather than each adapter inventing its own deadline.
   */
  signal: AbortSignal;
}

/** A hint the detector ranks. `null` means "not mine". */
export interface TrackingDetectionHint {
  /** Whether the number satisfied this carrier's check digit, not merely its shape. */
  checksumPassed: boolean;
  /** Higher wins. Only compared within one detection run. */
  score: number;
}

/** The verdict on an inbound webhook delivery. */
export interface WebhookVerdict {
  ok: boolean;
  /** The carrier's own delivery id, when it sends one. Becomes the dedupe claim. */
  eventId?: string;
  /** A bounded label for the log. Never a header, a body or a signature. */
  reason?: string;
}

/** One carrier the tracker knows how to read. */
export interface TrackingAdapter {
  /** Stable key; matches `tracking_carriers.key`. */
  key: string;
  capabilities: TrackingCapabilities;
  /** Claim a number as possibly this carrier's. Pure — no I/O. */
  detect?(normalisedNumber: string): TrackingDetectionHint | null;
  /** Absent exactly when `capabilities.deepLinkOnly`. */
  fetch?(input: TrackingFetchInput): Promise<TrackingSnapshot>;
  parseWebhook?(payload: unknown): TrackingSnapshot | null;
  verifyWebhook?(raw: Buffer, headers: Record<string, string | undefined>): WebhookVerdict;
  /**
   * The carrier's own tracking page. REQUIRED on every adapter, including ones
   * that poll: it is the "view on the carrier's site" link the app always
   * shows, and the fallback when polling has given up.
   */
  deepLink(input: { trackingNumber: string; locale?: string }): string;
}

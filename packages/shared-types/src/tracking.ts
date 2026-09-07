/**
 * Moovo Tracker — universal parcel tracking DTOs.
 *
 * A user pastes a tracking number from ANY carrier, Moovo detects which carrier
 * it belongs to and shows one timeline. Moovo's own deliveries appear in the
 * same list, so this vocabulary has to describe both a DHL parcel crossing a
 * border and a courier three streets away.
 *
 * ## Why this does not reuse `JobStatus`
 *
 * `JobStatus` is a DISPATCH AUCTION vocabulary: `offered` and `accepted`
 * describe Moovo's race between couriers, which no carrier has. And it is
 * missing the states that dominate parcel tracking — `info_received` (a label
 * exists, the parcel does not), `out_for_delivery` (the state people open the
 * app for), `available_for_pickup`, `failed_attempt` and `exception`. Mapping
 * a customs hold onto `cancelled` would state something false: nothing was
 * cancelled.
 *
 * A job is projected INTO this vocabulary for display
 * (`services/tracking/tracking-status.ts`); the two sets are never merged.
 */

import type { GeoPoint } from './courier';
import type { JobView } from './job';

/**
 * Where a parcel is, in the only words both a carrier and a Moovo courier can
 * be described with.
 *
 * `pending` and `info_received` are deliberately distinct: `pending` means we
 * hold a number and have never fetched successfully, `info_received` means the
 * carrier confirms it exists. That difference drives both the first-poll
 * cadence and the not-found expiry — a number that is merely unknown to us is
 * not the same as a label that was created and never scanned.
 */
export const TRACKING_STATUSES = [
  'pending',
  'info_received',
  'in_transit',
  'out_for_delivery',
  'available_for_pickup',
  'delivered',
  'failed_attempt',
  'exception',
  'returned',
  'expired',
  'cancelled',
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/**
 * Where a carrier's data comes from — and a LEGAL decision, per carrier, not a
 * technical one.
 *
 * `official_api` is a documented interface we are entitled to call.
 * `public_page` is the carrier's own tracking page, parsed. `deep_link_only`
 * is a carrier we never call at all: we hold the number and send the user to
 * their site.
 *
 * It is a stored column rather than a fact buried in an adapter precisely so
 * that "which carriers are we scraping" is answerable without reading code.
 */
export const TRACKING_SOURCE_KINDS = ['official_api', 'public_page', 'deep_link_only'] as const;
export type TrackingSourceKind = (typeof TRACKING_SOURCE_KINDS)[number];

/**
 * How a parcel's updates arrive.
 *
 * `poll` — we ask the carrier on a schedule.
 * `webhook` — the carrier pushes to us; we still poll, far more slowly, as the
 *   reconciliation backstop for a feed that stops silently.
 * `deeplink` — we never call anyone; the row exists to hold the number.
 * `manual` — polling gave up (or never applied), and only an explicit refresh
 *   will try again. A MODE rather than a status, so a parcel that cannot be
 *   fetched is still readable.
 */
export const TRACKING_POLL_MODES = ['poll', 'webhook', 'deeplink', 'manual'] as const;
export type TrackingPollMode = (typeof TRACKING_POLL_MODES)[number];

/**
 * A carrier as the tracker knows it.
 *
 * Distinct from `Provider`, which is a carrier Moovo can HAND A SHIPMENT TO.
 * The populations barely overlap: Moovo books with a handful, and tracks
 * hundreds it will never have a contract with.
 */
export interface TrackingCarrierSummary {
  key: string;
  name: string;
  logoUrl?: string;
  sourceKind: TrackingSourceKind;
  /** Whether Moovo can fetch status, or only link out. */
  pollSupported: boolean;
  countryCodes: string[];
}

/** One carrier the detector thinks a number might belong to. */
export interface CarrierGuess {
  carrierKey: string;
  name: string;
  /** Whether the number satisfied this carrier's check digit, not just its shape. */
  checksumPassed: boolean;
  /** Higher is better. Only meaningful for ordering within one response. */
  score: number;
}

/** One scan event on a parcel's journey. */
export interface TrackingCheckpoint {
  id: string;
  status: TrackingStatus;
  /** The carrier's own words, kept for diagnostics and for copy we have not mapped. */
  rawStatus?: string;
  description?: string;
  locationText?: string;
  countryCode?: string;
  location?: GeoPoint;
  occurredAt: string;
  /**
   * The carrier reported wall-clock time with no offset, so `occurredAt` is
   * that local time and not a true instant.
   *
   * Recorded rather than guessed: roughly half of carrier APIs report local
   * time, and inventing a UTC for it silently reorders the timeline the moment
   * a parcel crosses a timezone — with the app unable to tell that it happened.
   */
  occurredAtIsLocal: boolean;
}

/**
 * A parcel as one user sees it: the shared carrier identity plus that user's
 * own subscription to it.
 *
 * `id` is the SUBSCRIPTION's id, never the shared parcel's. The parcel row is
 * shared between everyone tracking that number, so exposing its id would let
 * anyone who learned one read a parcel they never added.
 */
export interface TrackedParcel {
  id: string;
  carrier: TrackingCarrierSummary;
  trackingNumber: string;
  status: TrackingStatus;
  rawStatus?: string;
  /** The user's own label for it ("zapatillas"), not the carrier's. */
  title?: string;
  serviceName?: string;
  originCountry?: string;
  destinationCountry?: string;
  estimatedDeliveryAt?: string;
  deliveredAt?: string;
  lastCheckpointAt?: string;
  checkpointCount: number;
  /** The carrier's own tracking page. Always present, for every carrier. */
  trackingUrl: string;
  notifyOnStateChange: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A parcel's detail view, discriminated by where its timeline comes from.
 *
 * The `moovo_job` variant carries the existing {@link JobView} DTO IMPORTED
 * rather than restated, so the live map, the courier card and proof of delivery
 * all keep working with no second shape of a job on the wire — and so a Moovo
 * delivery never has its history copied into the tracker's tables.
 *
 * `JobView` and not `Job`: the endpoint hydrates through
 * `job-hydration.service.ts`, which converts prices, so what actually arrives
 * carries `DisplayPriceBreakdown`. `checkpoints` is present and empty on that
 * arm rather than absent, so a client can read `detail.checkpoints` without
 * narrowing first — a Moovo delivery has zero checkpoints for its whole life
 * BY DESIGN, and that is a fact worth stating rather than a field to omit.
 */
export type TrackedParcelDetail =
  | { source: 'carrier'; parcel: TrackedParcel; checkpoints: TrackingCheckpoint[] }
  | { source: 'moovo_job'; parcel: TrackedParcel; job: JobView; checkpoints: [] };

/**
 * What an ANONYMOUS lookup returns.
 *
 * Deliberately not a {@link TrackedParcel}: there is no subscription, so there
 * is no id, no title and no notification preference — and nothing that belongs
 * to a person. See `services/tracking/public-facts.ts` for the allow-list of
 * fields a carrier response may contribute to this shape; a carrier that hands
 * us a recipient name or a delivery address must not pass it on.
 */
export interface PublicParcelLookup {
  carrier: TrackingCarrierSummary;
  trackingNumber: string;
  status: TrackingStatus;
  estimatedDeliveryAt?: string;
  deliveredAt?: string;
  lastCheckpointAt?: string;
  trackingUrl: string;
  checkpoints: TrackingCheckpoint[];
}

/** Add a parcel to the caller's own list. */
export interface TrackParcelInput {
  number: string;
  /** Omitted when the client wants the server to detect it. */
  carrierKey?: string;
  title?: string;
  /** Some carriers (Correos, Royal Mail) require it as a second factor. */
  destinationPostalCode?: string;
  destinationCountry?: string;
  notify?: boolean;
}

export interface UpdateTrackedParcelInput {
  title?: string;
  notify?: boolean;
  archived?: boolean;
  /**
   * Correct a wrong carrier. This RE-POINTS the subscription at the right
   * identity; it never rewrites the carrier of a parcel row, which is half of
   * the key other people are watching.
   */
  carrierKey?: string;
}

export interface DetectCarrierInput {
  number: string;
  destinationCountry?: string;
}

export interface LookupParcelInput {
  number: string;
  carrierKey?: string;
  destinationPostalCode?: string;
}

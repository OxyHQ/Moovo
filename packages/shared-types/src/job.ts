/**
 * Job DTOs for the Moovo transport domain.
 *
 * A `Job` is the booked, in-flight unit of work created from a selected `Quote`:
 * exactly ONE job per booked shipment. It is fulfilled EITHER by a Moovo courier
 * (`fulfillmentType: 'moovo_courier'`) OR by an external provider
 * (`fulfillmentType: 'external_provider'`). Pickup/dropoff/parcel/quote are
 * frozen SNAPSHOTS taken at booking time so a later shipment edit cannot mutate a
 * booked job. Money fields are FAIR {@link PriceBreakdown} values.
 *
 * Phase 3 adds real-time dispatch (Glovo-style): a booked Moovo-courier job is
 * fanned out as time-boxed {@link JobOffer}s to nearby eligible couriers. The job
 * moves `requested → offered` on the first dispatch wave and `offered → accepted`
 * when a courier wins the offer race (atomic CAS — first writer wins). The legacy
 * direct `requested → accepted` edge is retained for manual assignment.
 *
 * `GeoPoint` is reused from the courier domain; `PriceBreakdown`/`DisplayPriceBreakdown`
 * from the quote domain.
 */

import type { Timestamps } from './common';
import type { GeoPoint, SizeClass } from './courier';
import type { ShipmentType, ShipmentEndpoint, ParcelDetails } from './shipment';
import type { PriceBreakdown, DisplayPriceBreakdown } from './quote';

/**
 * Lifecycle status of a job.
 *
 * `requested` (booked, awaiting dispatch/assignment) → `offered` (fanned out to
 * nearby couriers as time-boxed offers) → `accepted` → `picked_up` → `in_transit`
 * → `delivered`; `cancelled` is a terminal exit reachable from any non-terminal
 * state. A job may also revert `offered → requested` when all offers expire with
 * no acceptance and the sweep re-dispatches. The direct `requested → accepted`
 * edge is retained for manual assignment (Phase 3 courier acceptance is
 * offer-gated, see {@link JobOffer}).
 */
export type JobStatus =
  | 'requested'
  | 'offered'
  | 'accepted'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'cancelled';

/** Who fulfils a job: a Moovo courier or an external provider. */
export type FulfillmentType = 'moovo_courier' | 'external_provider';

/**
 * Lifecycle status of a {@link JobOffer} — one fan-out offer of a job to a single
 * candidate courier during real-time dispatch.
 *
 * `offered` (live, awaiting the courier's response within the TTL) →
 * `accepted` (this courier won the offer race), `declined` (the courier passed),
 * `expired` (the TTL elapsed with no response), or `superseded` (a SIBLING offer
 * on the same job was accepted first, so this one is no longer claimable).
 */
export type JobOfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'superseded';

/**
 * A time-boxed dispatch offer of a job to a single candidate courier. Many offers
 * may be live for one job at once (a "wave"); the first courier to accept wins via
 * an atomic CAS on the job and all sibling offers are `superseded`.
 */
export interface JobOffer {
  /** Stable offer id. */
  id: string;
  /** The job being offered. */
  jobId: string;
  /** The shipment the job fulfils (denormalized for the courier UI). */
  shipmentId: string;
  /** Oxy user id of the candidate courier this offer is addressed to. */
  courierOxyUserId: string;
  /** Owning company id, when the candidate belongs to a fleet. */
  companyId?: string;
  /** Current offer status. */
  status: JobOfferStatus;
  /** ISO-8601 time the offer was created. */
  offeredAt: string;
  /** ISO-8601 time after which the offer is no longer claimable. */
  expiresAt: string;
  /** 0-based rank of this candidate within its dispatch wave (nearest = 0). */
  rank: number;
  /** Great-circle distance from the courier to the pickup, in metres. */
  distanceM: number;
}

/**
 * The compact offer projection pushed to a candidate courier over the
 * `job:offer` socket event — everything Moovo Go needs to render the offer card
 * and accept/decline, without leaking the sender's identity or contact details.
 */
export interface JobOfferView {
  /** Stable offer id. */
  offerId: string;
  /** The job being offered (the id the courier POSTs to accept). */
  jobId: string;
  /** The shipment the job fulfils. */
  shipmentId: string;
  /** What is being moved. */
  type: ShipmentType;
  /** Pickup city (coarse — full address is revealed on accept). */
  pickupCity: string;
  /** Dropoff city (coarse — full address is revealed on accept). */
  dropoffCity: string;
  /** Coarse parcel size class. */
  sizeClass: SizeClass;
  /** Job totals with both FAIR and a converted display amount. */
  totals: DisplayPriceBreakdown;
  /** Great-circle distance from the courier to the pickup, in metres. */
  distanceM: number;
  /** ISO-8601 time after which the offer is no longer claimable. */
  expiresAt: string;
}

/**
 * Body for `POST /jobs/:id/scan` — the assigned courier scans the sender's QR
 * code (or types the code) to prove pickup (`pickup` leg) or delivery (`dropoff`
 * leg). The code is verified against the job's stored hash; the plaintext is
 * never echoed back on a mismatch.
 */
export interface ScanInput {
  /** Which leg of the job this scan proves. */
  leg: 'pickup' | 'dropoff';
  /** The plaintext code read from the QR (or typed by the courier). */
  code: string;
  /** Optional Oxy media file id of a photo captured at the dropoff (POD). */
  photoFileId?: string;
}

/** A single entry in a job's status history (audit trail of transitions). */
export interface JobStatusEvent {
  /** The status the job moved INTO. */
  status: JobStatus;
  /** ISO-8601 time of the transition. */
  at: string;
  /** Oxy user id of the actor who triggered it, when known. */
  byOxyUserId?: string;
  /** Optional free-text note attached to the transition. */
  note?: string;
  /** Location at the time of the transition (e.g. pickup/delivery point). */
  location?: GeoPoint;
}

/** A courier location ping recorded against a job during transit. */
export interface LocationPing {
  /** GeoJSON point of the ping. */
  location: GeoPoint;
  /** ISO-8601 time of the ping. */
  at: string;
}

/** Proof captured at delivery. */
export interface ProofOfDelivery {
  /** Oxy media file id of a delivery photo, when captured. */
  photoFileId?: string;
  /** Oxy media file id of a captured signature, when captured. */
  signatureFileId?: string;
  /** Free-text note (e.g. "left with neighbour"). */
  note?: string;
  /** Name of the person who received the delivery. */
  recipientName?: string;
  /** ISO-8601 time the delivery was completed. */
  at: string;
}

/** Payment state + provider reference for a job (Oxy Pay). */
export interface JobPaymentInfo {
  /** Where the payment is in its own lifecycle. */
  status: 'unpaid' | 'authorized' | 'paid' | 'refunded' | 'failed';
  /** Payment provider that settled (or will settle) this job. */
  provider: 'oxy_pay';
  /** Provider-side reference/transaction id, when one exists. */
  reference?: string;
  /** ISO-8601 time the job was paid, when paid. */
  paidAt?: string;
}

/** An immutable endpoint snapshot taken at booking time. */
export type JobEndpointSnapshot = ShipmentEndpoint;

/** An immutable parcel snapshot taken at booking time. */
export type JobParcelSnapshot = ParcelDetails;

/**
 * A booked job. Snapshots are frozen at booking; FAIR price fields are the
 * source of truth (the API exposes a display conversion on the hydrated view).
 */
export interface Job extends Timestamps {
  /** Stable job id. */
  id: string;
  /** Sequential, human-friendly job number (e.g. `MOV-000123`). */
  jobNumber: string;
  /** The shipment this job fulfils. */
  shipmentId: string;
  /** Oxy user id of the customer who booked the job. */
  senderOxyUserId: string;
  /** What is being moved (denormalized from the shipment for indexing). */
  type: ShipmentType;
  /** Who fulfils the job. */
  fulfillmentType: FulfillmentType;
  /** Assigned Moovo courier's Oxy user id, for `moovo_courier` jobs. */
  courierOxyUserId?: string;
  /** Owning company id, when the courier belongs to a fleet. */
  companyId?: string;
  /** External provider booking reference, for `external_provider` jobs. */
  providerRef?: string;
  /** Immutable pickup snapshot taken at booking. */
  pickupSnapshot: JobEndpointSnapshot;
  /** Immutable dropoff snapshot taken at booking. */
  dropoffSnapshot: JobEndpointSnapshot;
  /** Immutable parcel snapshot taken at booking. */
  parcelSnapshot: JobParcelSnapshot;
  /** FAIR-priced breakdown snapshot of the selected quote. */
  quoteSnapshot: PriceBreakdown;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Audit trail of every status transition. */
  statusHistory: JobStatusEvent[];
  /** Recent courier location pings (capped to the most recent N). */
  locationPings: LocationPing[];
  /** Proof captured at delivery, once delivered. */
  proofOfDelivery?: ProofOfDelivery;
  /** Payment state + provider reference. */
  payment: JobPaymentInfo;
  /** FAIR-priced totals snapshot of the selected quote. */
  totals: PriceBreakdown;
  /** Number of dispatch waves attempted for this job (real-time dispatch). */
  dispatchAttempts: number;
  /**
   * Plaintext pickup code, surfaced ONLY in OWNER-scoped responses (the sender)
   * so the sender can show/relay it. Couriers and non-owners never receive it.
   */
  pickupCode?: string;
  /**
   * Plaintext dropoff code, surfaced ONLY in OWNER-scoped responses (the sender)
   * so the sender can relay it to the recipient. Couriers/non-owners never see it.
   */
  dropoffCode?: string;
}

/** The output projection of a job with display-converted prices. */
export interface JobView {
  /** Stable job id. */
  id: string;
  /** Sequential, human-friendly job number. */
  jobNumber: string;
  /** The shipment this job fulfils. */
  shipmentId: string;
  /** Oxy user id of the customer who booked the job. */
  senderOxyUserId: string;
  /** What is being moved. */
  type: ShipmentType;
  /** Who fulfils the job. */
  fulfillmentType: FulfillmentType;
  /** Assigned Moovo courier's Oxy user id, for `moovo_courier` jobs. */
  courierOxyUserId?: string;
  /** Owning company id, when the courier belongs to a fleet. */
  companyId?: string;
  /** External provider booking reference, for `external_provider` jobs. */
  providerRef?: string;
  /** Immutable pickup snapshot. */
  pickupSnapshot: JobEndpointSnapshot;
  /** Immutable dropoff snapshot. */
  dropoffSnapshot: JobEndpointSnapshot;
  /** Immutable parcel snapshot. */
  parcelSnapshot: JobParcelSnapshot;
  /** Quote price breakdown with both FAIR and a converted display amount. */
  quoteSnapshot: DisplayPriceBreakdown;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Audit trail of every status transition. */
  statusHistory: JobStatusEvent[];
  /** Recent courier location pings. */
  locationPings: LocationPing[];
  /** Proof captured at delivery, once delivered. */
  proofOfDelivery?: ProofOfDelivery;
  /** Payment state + provider reference. */
  payment: JobPaymentInfo;
  /** Totals with both FAIR and a converted display amount. */
  totals: DisplayPriceBreakdown;
  /** Number of dispatch waves attempted for this job (real-time dispatch). */
  dispatchAttempts: number;
  /**
   * Plaintext pickup code — present ONLY in OWNER-scoped responses (the sender).
   * Couriers and non-owners never receive it; they prove pickup by scanning.
   */
  pickupCode?: string;
  /**
   * Plaintext dropoff code — present ONLY in OWNER-scoped responses (the sender),
   * who relays it to the recipient. Couriers/non-owners never receive it.
   */
  dropoffCode?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/** A compact job projection for job lists (sender + courier dashboards). */
export interface JobSummary {
  /** Stable job id. */
  id: string;
  /** Sequential, human-friendly job number. */
  jobNumber: string;
  /** The shipment this job fulfils. */
  shipmentId: string;
  /** What is being moved. */
  type: ShipmentType;
  /** Who fulfils the job. */
  fulfillmentType: FulfillmentType;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Coarse size class of the parcel (from the snapshot). */
  sizeClass: SizeClass;
  /** Totals with both FAIR and a converted display amount. */
  totals: DisplayPriceBreakdown;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** Body for `POST /shipments/:id/book` — book a selected quote. */
export interface BookShipmentInput {
  /** The quote to book. */
  quoteId: string;
  /** Optional idempotency key so a replayed booking converges on the same job. */
  idempotencyKey?: string;
}

/** Result of a successful booking: the created job. */
export interface BookResult {
  /** The created job (display-converted). */
  job: JobView;
}

/** Proof-of-delivery payload accepted at the `deliver` transition. */
export interface DeliverInput {
  /** Oxy media file id of a delivery photo. */
  photoFileId?: string;
  /** Oxy media file id of a captured signature. */
  signatureFileId?: string;
  /** Free-text note. */
  note?: string;
  /** Name of the person who received the delivery. */
  recipientName?: string;
}

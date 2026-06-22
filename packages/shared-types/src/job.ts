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
 * Phase 2 assignment is DIRECT/manual: a booked job starts `requested` and moves
 * to `accepted` on assignment — there is NO `offered` state and no offer fan-out
 * (that is Phase 3 dispatch).
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
 * `requested` (booked, awaiting assignment/acceptance) → `accepted` → `picked_up`
 * → `in_transit` → `delivered`; `cancelled` is a terminal exit reachable from any
 * non-terminal state. NOTE: there is intentionally NO `offered` state in Phase 2.
 */
export type JobStatus =
  | 'requested'
  | 'accepted'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'cancelled';

/** Who fulfils a job: a Moovo courier or an external provider. */
export type FulfillmentType = 'moovo_courier' | 'external_provider';

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

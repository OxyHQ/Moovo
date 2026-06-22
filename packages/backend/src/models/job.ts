/**
 * Job model — the booked, in-flight unit of work created from a selected quote.
 *
 * Exactly ONE job per booked shipment. Fulfilled EITHER by a Moovo courier
 * (`fulfillmentType: 'moovo_courier'`, `courierOxyUserId` set, no `providerRef`)
 * OR by an external provider (`fulfillmentType: 'external_provider'`,
 * `providerRef` set, no courier/company) — enforced by a `pre('validate')` hook
 * (same pattern as `listing.ts`/`vehicle.ts`). Pickup/dropoff/parcel/quote are
 * frozen SNAPSHOTS (`{_id:false}`) taken at booking. `statusHistory` is the audit
 * trail; `locationPings` is CAPPED at `config.jobs.maxLocationPings` via a
 * `$slice` push. `idempotencyKey` is sparse-unique so a replayed booking
 * converges on the same job. FAIR money is stored via {@link FairMoneySchema}.
 *
 * Phase 3 real-time dispatch adds the `offered` status, a `dispatchAttempts` wave
 * counter, and the QR pickup/delivery proof. A booked `moovo_courier` job carries
 * two codes per leg: a `*CodeHash` (the SHA-256 verify source the courier scans
 * against — the courier never sees the plaintext) AND a `*Code` plaintext that is
 * surfaced ONLY in OWNER-scoped DTOs (the sender, who relays the dropoff code to
 * the recipient). See `hydrateJob`'s `includeCodes` gate.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  JobStatus,
  FulfillmentType,
  ShipmentType,
  SizeClass,
  JobPaymentInfo,
} from '@moovo/shared-types';
import { FairMoneySchema } from './schemas/fair-money-schema.js';
import type { IPriceBreakdown } from './quote.js';
import type {
  IShipmentEndpoint,
  IParcelDetails,
  IGeoPoint,
} from './shipment.js';

const JOB_STATUSES: readonly JobStatus[] = [
  'requested',
  'offered',
  'accepted',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
];
const FULFILLMENT_TYPES: readonly FulfillmentType[] = ['moovo_courier', 'external_provider'];
const SHIPMENT_TYPES: readonly ShipmentType[] = ['package', 'food', 'move'];
const SIZE_CLASSES: readonly SizeClass[] = ['small', 'medium', 'large'];
const PAYMENT_STATUSES: readonly JobPaymentInfo['status'][] = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
  'failed',
];
const PAYMENT_PROVIDERS: readonly JobPaymentInfo['provider'][] = ['oxy_pay'];

export interface IJobStatusEvent {
  status: JobStatus;
  at: Date;
  byOxyUserId?: string;
  note?: string;
  location?: IGeoPoint;
}

export interface ILocationPing {
  location: IGeoPoint;
  at: Date;
}

export interface IProofOfDelivery {
  photoFileId?: string;
  signatureFileId?: string;
  note?: string;
  recipientName?: string;
  at: Date;
}

export interface IJobPaymentInfo {
  status: JobPaymentInfo['status'];
  provider: JobPaymentInfo['provider'];
  reference?: string;
  paidAt?: Date;
}

export interface IJob {
  _id: mongoose.Types.ObjectId;
  jobNumber: string;
  shipmentId: string;
  senderOxyUserId: string;
  type: ShipmentType;
  fulfillmentType: FulfillmentType;
  courierOxyUserId?: string;
  companyId?: string;
  providerRef?: string;
  pickupSnapshot: IShipmentEndpoint;
  dropoffSnapshot: IShipmentEndpoint;
  parcelSnapshot: IParcelDetails;
  quoteSnapshot: IPriceBreakdown;
  status: JobStatus;
  statusHistory: IJobStatusEvent[];
  locationPings: ILocationPing[];
  proofOfDelivery?: IProofOfDelivery;
  payment: IJobPaymentInfo;
  totals: IPriceBreakdown;
  /** Number of dispatch waves attempted (real-time dispatch). */
  dispatchAttempts: number;
  /** SHA-256 hex hash the pickup scan is verified against (verify source). */
  pickupCodeHash?: string;
  /** SHA-256 hex hash the dropoff scan is verified against (verify source). */
  dropoffCodeHash?: string;
  /** Plaintext pickup code — surfaced ONLY to the OWNER (sender) at hydration. */
  pickupCode?: string;
  /** Plaintext dropoff code — surfaced ONLY to the OWNER (sender) at hydration. */
  dropoffCode?: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GeoPointSchema = new Schema<IGeoPoint>(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const ShipmentAddressSnapshotSchema = new Schema(
  {
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    region: { type: String },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false },
);

const EndpointSnapshotSchema = new Schema<IShipmentEndpoint>(
  {
    location: { type: GeoPointSchema, required: true },
    address: { type: ShipmentAddressSnapshotSchema, required: true },
    contactName: { type: String, required: true },
    contactPhone: { type: String, required: true },
    notes: { type: String },
  },
  { _id: false },
);

const ParcelSnapshotSchema = new Schema<IParcelDetails>(
  {
    weightKg: { type: Number, required: true },
    dimsCm: {
      l: { type: Number },
      w: { type: Number },
      h: { type: Number },
    },
    sizeClass: { type: String, enum: SIZE_CLASSES as string[], required: true },
    pieces: { type: Number, required: true, default: 1 },
    fragile: { type: Boolean, default: false },
  },
  { _id: false },
);

const PriceBreakdownSnapshotSchema = new Schema<IPriceBreakdown>(
  {
    base: { type: FairMoneySchema, required: true },
    distance: { type: FairMoneySchema, required: true },
    size: { type: FairMoneySchema, required: true },
    surge: { type: FairMoneySchema },
    fees: { type: FairMoneySchema },
    total: { type: FairMoneySchema, required: true },
  },
  { _id: false },
);

const JobStatusEventSchema = new Schema<IJobStatusEvent>(
  {
    status: { type: String, enum: JOB_STATUSES as string[], required: true },
    at: { type: Date, default: Date.now },
    byOxyUserId: { type: String },
    note: { type: String },
    location: { type: GeoPointSchema },
  },
  { _id: false },
);

const LocationPingSchema = new Schema<ILocationPing>(
  {
    location: { type: GeoPointSchema, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ProofOfDeliverySchema = new Schema<IProofOfDelivery>(
  {
    photoFileId: { type: String },
    signatureFileId: { type: String },
    note: { type: String },
    recipientName: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const JobPaymentSchema = new Schema<IJobPaymentInfo>(
  {
    status: { type: String, enum: PAYMENT_STATUSES as string[], default: 'unpaid' },
    provider: { type: String, enum: PAYMENT_PROVIDERS as string[], default: 'oxy_pay' },
    reference: { type: String },
    paidAt: { type: Date },
  },
  { _id: false },
);

const JobSchema = new Schema<IJob>(
  {
    jobNumber: { type: String, required: true },
    shipmentId: { type: String, required: true },
    senderOxyUserId: { type: String, required: true },
    type: { type: String, enum: SHIPMENT_TYPES as string[], required: true },
    fulfillmentType: { type: String, enum: FULFILLMENT_TYPES as string[], required: true },
    courierOxyUserId: { type: String },
    companyId: { type: String },
    providerRef: { type: String },
    pickupSnapshot: { type: EndpointSnapshotSchema, required: true },
    dropoffSnapshot: { type: EndpointSnapshotSchema, required: true },
    parcelSnapshot: { type: ParcelSnapshotSchema, required: true },
    quoteSnapshot: { type: PriceBreakdownSnapshotSchema, required: true },
    status: { type: String, enum: JOB_STATUSES as string[], default: 'requested' },
    statusHistory: { type: [JobStatusEventSchema], default: [] },
    locationPings: { type: [LocationPingSchema], default: [] },
    proofOfDelivery: { type: ProofOfDeliverySchema },
    payment: { type: JobPaymentSchema, default: () => ({}) },
    totals: { type: PriceBreakdownSnapshotSchema, required: true },
    dispatchAttempts: { type: Number, default: 0 },
    pickupCodeHash: { type: String },
    dropoffCodeHash: { type: String },
    pickupCode: { type: String },
    dropoffCode: { type: String },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

/**
 * Enforce that the fulfilment owner is consistent with `fulfillmentType`:
 * - `'moovo_courier'`     ⇒ a courier may be assigned (`courierOxyUserId`),
 *   `providerRef` MUST be unset.
 * - `'external_provider'` ⇒ `providerRef` set, `courierOxyUserId`/`companyId`
 *   MUST be unset.
 *
 * A `moovo_courier` job may legitimately be unassigned (`requested`), so
 * `courierOxyUserId` is NOT required here — only mutual exclusion is enforced.
 * Synchronous hook that throws on violation — Mongoose 9 rejects validation with
 * the thrown error.
 */
JobSchema.pre('validate', function preValidate() {
  if (this.fulfillmentType === 'moovo_courier') {
    if (this.providerRef) {
      throw new Error("Job fulfillmentType 'moovo_courier' must not set providerRef");
    }
  } else if (this.fulfillmentType === 'external_provider') {
    if (!this.providerRef) {
      throw new Error("Job fulfillmentType 'external_provider' requires providerRef");
    }
    if (this.courierOxyUserId) {
      throw new Error("Job fulfillmentType 'external_provider' must not set courierOxyUserId");
    }
    if (this.companyId) {
      throw new Error("Job fulfillmentType 'external_provider' must not set companyId");
    }
  } else {
    throw new Error(`Invalid Job fulfillmentType: ${String(this.fulfillmentType)}`);
  }
});

JobSchema.index({ jobNumber: 1 }, { unique: true });
JobSchema.index({ senderOxyUserId: 1, createdAt: -1 });
JobSchema.index({ courierOxyUserId: 1, status: 1, createdAt: -1 });
JobSchema.index({ status: 1, type: 1 });
JobSchema.index({ shipmentId: 1 });
JobSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const Job: Model<IJob> =
  mongoose.models.Job || mongoose.model<IJob>('Job', JobSchema);

/**
 * Shipment model — a customer's request to move something (the entry point of
 * the request → quotes → booking → job lifecycle).
 *
 * Holds the pickup/dropoff endpoints (each a GeoJSON `Point` + address snapshot +
 * contact), the parcel/cargo details and scheduling. Carries NO price — pricing
 * lives on the `Quote` children generated for the shipment. Two `2dsphere`
 * indexes (pickup + dropoff) back the distance/dispatch geo-queries, mirroring
 * `listing.ts`'s geo mechanics. `senderOxyUserId` is ALWAYS a String (Oxy user
 * id), never an ObjectId/ref.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ShipmentType, ShipmentStatus, SizeClass } from '@moovo/shared-types';

const SHIPMENT_TYPES: readonly ShipmentType[] = ['package', 'food', 'move'];
const SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'draft',
  'quoting',
  'quoted',
  'booked',
  'cancelled',
  'expired',
];
const SIZE_CLASSES: readonly SizeClass[] = ['small', 'medium', 'large'];
const SCHEDULING_KINDS = ['now', 'scheduled'] as const;

export interface IGeoPoint {
  type: 'Point';
  /** [lng, lat] per GeoJSON. */
  coordinates: number[];
}

export interface IShipmentAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

export interface IShipmentEndpoint {
  location: IGeoPoint;
  address: IShipmentAddress;
  contactName: string;
  contactPhone: string;
  notes?: string;
}

export interface IDimensionsCm {
  l: number;
  w: number;
  h: number;
}

export interface IParcelDetails {
  weightKg: number;
  dimsCm?: IDimensionsCm;
  sizeClass: SizeClass;
  pieces: number;
  fragile?: boolean;
}

export interface IScheduling {
  kind: (typeof SCHEDULING_KINDS)[number];
  scheduledFor?: Date;
}

export interface IShipmentPhoto {
  fileId: string;
  alt?: string;
  position: number;
}

export interface IShipment {
  _id: mongoose.Types.ObjectId;
  senderOxyUserId: string;
  type: ShipmentType;
  status: ShipmentStatus;
  pickup: IShipmentEndpoint;
  dropoff: IShipmentEndpoint;
  parcel: IParcelDetails;
  itemDescription: string;
  photos: IShipmentPhoto[];
  scheduling: IScheduling;
  distanceM?: number;
  quoteRef?: string;
  jobId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ShipmentAddressSchema = new Schema<IShipmentAddress>(
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

const ShipmentEndpointSchema = new Schema<IShipmentEndpoint>(
  {
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
      },
      coordinates: { type: [Number], required: true },
    },
    address: { type: ShipmentAddressSchema, required: true },
    contactName: { type: String, required: true },
    contactPhone: { type: String, required: true },
    notes: { type: String },
  },
  { _id: false },
);

const DimensionsCmSchema = new Schema<IDimensionsCm>(
  {
    l: { type: Number, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
  },
  { _id: false },
);

const ParcelDetailsSchema = new Schema<IParcelDetails>(
  {
    weightKg: { type: Number, required: true },
    dimsCm: { type: DimensionsCmSchema },
    sizeClass: { type: String, enum: SIZE_CLASSES as string[], required: true },
    pieces: { type: Number, required: true, default: 1 },
    fragile: { type: Boolean, default: false },
  },
  { _id: false },
);

const SchedulingSchema = new Schema<IScheduling>(
  {
    kind: { type: String, enum: SCHEDULING_KINDS as unknown as string[], default: 'now' },
    scheduledFor: { type: Date },
  },
  { _id: false },
);

const ShipmentPhotoSchema = new Schema<IShipmentPhoto>(
  {
    fileId: { type: String, required: true },
    alt: { type: String },
    position: { type: Number, default: 0 },
  },
  { _id: false },
);

const ShipmentSchema = new Schema<IShipment>(
  {
    senderOxyUserId: { type: String, required: true },
    type: { type: String, enum: SHIPMENT_TYPES as string[], required: true },
    status: { type: String, enum: SHIPMENT_STATUSES as string[], default: 'draft' },
    pickup: { type: ShipmentEndpointSchema, required: true },
    dropoff: { type: ShipmentEndpointSchema, required: true },
    parcel: { type: ParcelDetailsSchema, required: true },
    itemDescription: { type: String, default: '' },
    photos: { type: [ShipmentPhotoSchema], default: [] },
    scheduling: { type: SchedulingSchema, default: () => ({ kind: 'now' }) },
    distanceM: { type: Number },
    quoteRef: { type: String },
    jobId: { type: String },
  },
  { timestamps: true },
);

/**
 * A `scheduled` shipment MUST carry a `scheduledFor` time; a `now` shipment must
 * not. Synchronous hook that throws on violation — Mongoose 9 rejects validation
 * with the thrown error.
 */
ShipmentSchema.pre('validate', function preValidate() {
  if (this.scheduling?.kind === 'scheduled') {
    if (!this.scheduling.scheduledFor) {
      throw new Error("Shipment scheduling 'scheduled' requires scheduledFor");
    }
  } else if (this.scheduling?.kind === 'now' && this.scheduling.scheduledFor) {
    throw new Error("Shipment scheduling 'now' must not set scheduledFor");
  }
});

ShipmentSchema.index({ 'pickup.location': '2dsphere' });
ShipmentSchema.index({ 'dropoff.location': '2dsphere' });
ShipmentSchema.index({ senderOxyUserId: 1, createdAt: -1 });
ShipmentSchema.index({ status: 1, type: 1 });

export const Shipment: Model<IShipment> =
  mongoose.models.Shipment || mongoose.model<IShipment>('Shipment', ShipmentSchema);

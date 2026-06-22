/**
 * CourierProfile model — the Moovo-scoped profile of an individual courier
 * ("Glovo mode"), keyed by their Oxy user id.
 *
 * Holds the aggregates Moovo owns (verification status, rating, job counts) and
 * the real-time availability + denormalized capability cache (recomputed from
 * the active vehicle). Display name / username / avatar are NEVER stored here —
 * they are read live from the Oxy profile at hydration time. `currentLocation`
 * is a GeoJSON point with a 2dsphere index (same pattern as `listing.ts`).
 */

import mongoose, { Schema, Model } from 'mongoose';
import type {
  CourierStatus,
  OnlineStatus,
  JobType,
  SizeClass,
} from '@moovo/shared-types';

const STATUSES: readonly CourierStatus[] = ['pending', 'active', 'suspended'];
const ONLINE_STATUSES: readonly OnlineStatus[] = ['online', 'offline', 'on_job'];
const SIZE_CLASSES: readonly SizeClass[] = ['small', 'medium', 'large'];
const PAYOUT_PROVIDERS = ['oxy_pay'] as const;

export interface ICourierPayout {
  provider: (typeof PAYOUT_PROVIDERS)[number];
  accountRef?: string;
}

export interface ICourierGeoPoint {
  type: 'Point';
  /** [lng, lat] per GeoJSON. */
  coordinates: number[];
}

export interface ICourierProfile {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  status: CourierStatus;
  onlineStatus: OnlineStatus;
  currentLocation?: ICourierGeoPoint;
  lastPingAt?: Date;
  vehicleIds: string[];
  activeVehicleId?: string;
  /** Denormalized from the active vehicle's capability. */
  eligibleJobTypes: JobType[];
  maxWeightKg: number;
  maxSizeClass: SizeClass;
  rating: number;
  reviewCount: number;
  completedJobs: number;
  cancelledJobs: number;
  acceptanceRate?: number;
  payout: ICourierPayout;
  companyId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CourierPayoutSchema = new Schema<ICourierPayout>(
  {
    provider: {
      type: String,
      enum: PAYOUT_PROVIDERS as unknown as string[],
      default: 'oxy_pay',
    },
    accountRef: { type: String },
  },
  { _id: false },
);

// GeoJSON Point sub-schema. Modelled as a sub-schema (not an inline nested
// object) with `default: undefined` on the field so Mongoose NEVER auto-creates
// an empty/partial `{ coordinates: [] }`. An empty value is invalid GeoJSON and
// the 2dsphere index rejects the whole write (MongoServerError 16755). When the
// courier sends a location ping the value is a complete, valid Point.
const CourierGeoPointSchema = new Schema<ICourierGeoPoint>(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    // [lng, lat] per GeoJSON; required so the field is only ever a valid Point.
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const CourierProfileSchema = new Schema<ICourierProfile>(
  {
    oxyUserId: { type: String, required: true },
    status: { type: String, enum: STATUSES as string[], default: 'pending' },
    onlineStatus: { type: String, enum: ONLINE_STATUSES as string[], default: 'offline' },
    // ABSENT until the courier sends a location ping (default: undefined). The
    // 2dsphere index ignores documents missing the field, but rejects a present
    // invalid one — so we must never persist an empty Point.
    currentLocation: { type: CourierGeoPointSchema, default: undefined },
    lastPingAt: { type: Date },
    vehicleIds: { type: [String], default: [] },
    activeVehicleId: { type: String },
    eligibleJobTypes: { type: [String], default: [] },
    maxWeightKg: { type: Number, default: 0 },
    maxSizeClass: { type: String, enum: SIZE_CLASSES as string[], default: 'small' },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    completedJobs: { type: Number, default: 0 },
    cancelledJobs: { type: Number, default: 0 },
    acceptanceRate: { type: Number },
    payout: { type: CourierPayoutSchema, default: () => ({ provider: 'oxy_pay' }) },
    companyId: { type: String },
  },
  { timestamps: true },
);

CourierProfileSchema.index({ oxyUserId: 1 }, { unique: true });
CourierProfileSchema.index({ currentLocation: '2dsphere' }, { sparse: true });
CourierProfileSchema.index({ onlineStatus: 1, lastPingAt: -1 });

export const CourierProfile: Model<ICourierProfile> =
  mongoose.models.CourierProfile ||
  mongoose.model<ICourierProfile>('CourierProfile', CourierProfileSchema);

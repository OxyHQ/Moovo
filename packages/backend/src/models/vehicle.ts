/**
 * Vehicle model — a vehicle operated by a courier or a company.
 *
 * Owned EITHER by an individual courier (`ownerType: 'courier'`,
 * `courierOxyUserId` set) OR by a company (`ownerType: 'company'`, `companyId`
 * set) — enforced as mutually exclusive by a `pre('validate')` hook (the same
 * pattern `listing.ts` uses for user/store ownership). `eligibleJobTypes` is
 * DENORMALIZED at write time from the capability table for this vehicle's
 * `type`, so job matching can run off the indexed vehicle/courier fields without
 * recomputing the rules.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { JobType, VehicleType } from '@moovo/shared-types';

const OWNER_TYPES = ['courier', 'company'] as const;
const VEHICLE_TYPES: readonly VehicleType[] = ['bike', 'scooter', 'car', 'van', 'truck'];
const STATUSES = ['active', 'inactive'] as const;

export interface IVehicleCapacity {
  maxWeightKg: number;
  maxVolumeL?: number;
  maxDimsCm?: { l: number; w: number; h: number };
}

export interface IVehicle {
  _id: mongoose.Types.ObjectId;
  ownerType: (typeof OWNER_TYPES)[number];
  courierOxyUserId?: string;
  companyId?: string;
  type: VehicleType;
  label?: string;
  plate?: string;
  capacity: IVehicleCapacity;
  /** Denormalized at write from the capability table for `type`. */
  eligibleJobTypes: JobType[];
  status: (typeof STATUSES)[number];
  createdAt: Date;
  updatedAt: Date;
}

const VehicleCapacitySchema = new Schema<IVehicleCapacity>(
  {
    maxWeightKg: { type: Number, default: 0 },
    maxVolumeL: { type: Number },
    maxDimsCm: {
      l: { type: Number },
      w: { type: Number },
      h: { type: Number },
    },
  },
  { _id: false },
);

const VehicleSchema = new Schema<IVehicle>(
  {
    ownerType: { type: String, enum: OWNER_TYPES as unknown as string[], required: true },
    courierOxyUserId: { type: String },
    companyId: { type: String },
    type: { type: String, enum: VEHICLE_TYPES as string[], required: true },
    label: { type: String },
    plate: { type: String },
    capacity: { type: VehicleCapacitySchema, default: () => ({ maxWeightKg: 0 }) },
    eligibleJobTypes: { type: [String], default: [] },
    status: { type: String, enum: STATUSES as unknown as string[], default: 'active' },
  },
  { timestamps: true },
);

/**
 * Enforce that exactly one owner is set, consistent with `ownerType`:
 * - `'courier'` ⇒ `courierOxyUserId` set, `companyId` unset
 * - `'company'` ⇒ `companyId` set, `courierOxyUserId` unset
 *
 * Synchronous hook that throws on violation — Mongoose 9 rejects validation
 * with the thrown error.
 */
VehicleSchema.pre('validate', function preValidate() {
  if (this.ownerType === 'courier') {
    if (!this.courierOxyUserId) {
      throw new Error("Vehicle ownerType 'courier' requires courierOxyUserId");
    }
    if (this.companyId) {
      throw new Error("Vehicle ownerType 'courier' must not set companyId");
    }
  } else if (this.ownerType === 'company') {
    if (!this.companyId) {
      throw new Error("Vehicle ownerType 'company' requires companyId");
    }
    if (this.courierOxyUserId) {
      throw new Error("Vehicle ownerType 'company' must not set courierOxyUserId");
    }
  } else {
    throw new Error(`Invalid Vehicle ownerType: ${String(this.ownerType)}`);
  }
});

VehicleSchema.index({ courierOxyUserId: 1 });
VehicleSchema.index({ companyId: 1 });

export const Vehicle: Model<IVehicle> =
  mongoose.models.Vehicle || mongoose.model<IVehicle>('Vehicle', VehicleSchema);

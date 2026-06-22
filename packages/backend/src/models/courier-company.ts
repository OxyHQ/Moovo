/**
 * CourierCompany model — a fleet organization whose members (couriers /
 * dispatchers) fulfil jobs.
 *
 * Distinct from an individual courier (`CourierProfile`). Members are embedded
 * with a role + granular permission list; `oxyUserId` is ALWAYS a String (Oxy
 * user id), never an ObjectId/ref. `serviceAreas` are GeoJSON-center circles
 * describing where the company operates.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { CompanyRole, CompanyPermission, TextTone } from '@moovo/shared-types';
import { CURRENCY_CODES } from './schemas/money-schema.js';

const COMPANY_ROLES: readonly CompanyRole[] = ['owner', 'dispatcher', 'driver'];
const COMPANY_PERMISSIONS: readonly CompanyPermission[] = [
  'company:manage',
  'members:manage',
  'fleet:write',
  'jobs:read',
  'jobs:dispatch',
  'stats:read',
];
const COMPANY_STATUSES = ['active', 'suspended', 'closed'] as const;
const TEXT_TONES: readonly TextTone[] = ['light', 'dark'];
const PAYOUT_PROVIDERS = ['oxy_pay'] as const;

export interface ICompanyMember {
  oxyUserId: string;
  role: CompanyRole;
  permissions: CompanyPermission[];
  joinedBy?: string;
  joinedAt: Date;
}

export interface ICompanyServiceArea {
  center: {
    type: 'Point';
    /** [lng, lat] per GeoJSON. */
    coordinates: number[];
  };
  radiusM: number;
}

export interface ICompanyPayout {
  provider: (typeof PAYOUT_PROVIDERS)[number];
  accountRef?: string;
}

export interface ICompany {
  _id: mongoose.Types.ObjectId;
  handle: string;
  name: string;
  description: string;
  logoFileId?: string;
  coverFileId?: string;
  brandColor: string;
  textTone: TextTone;
  status: (typeof COMPANY_STATUSES)[number];
  members: ICompanyMember[];
  serviceAreas: ICompanyServiceArea[];
  defaultCurrency: string;
  rating: number;
  reviewCount: number;
  completedJobs: number;
  payout: ICompanyPayout;
  createdAt: Date;
  updatedAt: Date;
}

const CompanyMemberSchema = new Schema<ICompanyMember>(
  {
    oxyUserId: { type: String, required: true },
    role: { type: String, enum: COMPANY_ROLES as string[], required: true },
    permissions: { type: [String], default: [] },
    joinedBy: { type: String },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const CompanyServiceAreaSchema = new Schema<ICompanyServiceArea>(
  {
    center: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: { type: [Number] },
    },
    radiusM: { type: Number, required: true },
  },
  { _id: false },
);

const CompanyPayoutSchema = new Schema<ICompanyPayout>(
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

const CompanySchema = new Schema<ICompany>(
  {
    handle: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    logoFileId: { type: String },
    coverFileId: { type: String },
    brandColor: { type: String, required: true },
    textTone: { type: String, enum: TEXT_TONES as string[], default: 'light' },
    status: { type: String, enum: COMPANY_STATUSES as unknown as string[], default: 'active' },
    members: { type: [CompanyMemberSchema], default: [] },
    serviceAreas: { type: [CompanyServiceAreaSchema], default: [] },
    defaultCurrency: { type: String, enum: CURRENCY_CODES as string[], default: 'USD' },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    completedJobs: { type: Number, default: 0 },
    payout: { type: CompanyPayoutSchema, default: () => ({ provider: 'oxy_pay' }) },
  },
  { timestamps: true },
);

CompanySchema.index({ handle: 1 }, { unique: true });
CompanySchema.index({ 'members.oxyUserId': 1 });
CompanySchema.index({ status: 1, createdAt: -1 });

// The full company-permission set, exported so seeds and member-management can
// grant an owner all permissions without re-listing.
export const ALL_COMPANY_PERMISSIONS: readonly CompanyPermission[] = COMPANY_PERMISSIONS;

export const CourierCompany: Model<ICompany> =
  mongoose.models.CourierCompany ||
  mongoose.model<ICompany>('CourierCompany', CompanySchema);

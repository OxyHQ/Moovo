/**
 * Courier company (fleet) admin-facing DTOs for Moovo.
 *
 * A `Company` is a fleet organization whose members (couriers/dispatchers)
 * fulfil jobs, as opposed to an individual courier (`Courier`). This module
 * holds the ADMIN-facing shapes (members, permissions, service areas). `members`
 * are backed by Oxy user accounts; `oxyUserId` is ALWAYS a String (Oxy user id).
 */

import type { Timestamps } from './common';
import type { CurrencyCode } from './money';
import type { TextTone } from './product';
import type { GeoPoint, CourierPayout } from './courier';

/** A member's role within a company. */
export type CompanyRole = 'owner' | 'dispatcher' | 'driver';

/** A granular permission a company member can hold. */
export type CompanyPermission =
  | 'company:manage'
  | 'members:manage'
  | 'fleet:write'
  | 'jobs:read'
  | 'jobs:dispatch'
  | 'stats:read';

/** A member of a company, backed by an Oxy user account. */
export interface CompanyMember {
  /** Owning Oxy user account id. */
  oxyUserId: string;
  /** Role within the company. */
  role: CompanyRole;
  /** Granular permissions granted to this member. */
  permissions: CompanyPermission[];
  /** Oxy user id of the member who added this member, when known. */
  joinedBy?: string;
  /** ISO-8601 time the member joined the company. */
  joinedAt: string;
}

/** A geographic area a company serves: a circle around a center point. */
export interface CompanyServiceArea {
  /** Center of the service area (GeoJSON point). */
  center: GeoPoint;
  /** Service radius, metres. */
  radiusM: number;
}

/** A courier company (fleet). */
export interface Company extends Timestamps {
  /** Stable company id. */
  id: string;
  /** Unique handle (without leading @), used to build the `/c/<handle>` route. */
  handle: string;
  /** Display name of the company. */
  name: string;
  /** Long-form company description. */
  description: string;
  /** Oxy media file id (or absolute URL) of the company logo/wordmark. */
  logoFileId?: string;
  /** Oxy media file id (or absolute URL) of the company cover image. */
  coverFileId?: string;
  /** Solid brand color (full CSS color string, e.g. `#1D4ED8`). */
  brandColor: string;
  /** Which text tone reads best over this company's brand color/cover. */
  textTone: TextTone;
  /** Lifecycle status. */
  status: 'active' | 'suspended' | 'closed';
  /** Company members and their roles. */
  members: CompanyMember[];
  /** Geographic areas the company serves. */
  serviceAreas: CompanyServiceArea[];
  /** Default currency for jobs/payouts in this company. */
  defaultCurrency: CurrencyCode;
  /** Aggregate rating, 0–5. */
  rating: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount: number;
  /** Number of completed jobs. */
  completedJobs: number;
  /** Payout configuration. */
  payout: CourierPayout;
}

/** Payload accepted when creating a new company. */
export interface CreateCompanyInput {
  name: string;
  description?: string;
  brandColor?: string;
  logoFileId?: string;
  coverFileId?: string;
  defaultCurrency?: CurrencyCode;
  serviceAreas?: CompanyServiceArea[];
}

/** Partial payload accepted when updating an existing company. */
export type UpdateCompanyInput = Partial<CreateCompanyInput> & {
  textTone?: TextTone;
  status?: Company['status'];
};

/** Payload accepted when inviting a member to a company. */
export interface InviteCompanyMemberInput {
  oxyUserId: string;
  role: CompanyRole;
  permissions?: CompanyPermission[];
}

/** Partial payload accepted when updating a company member's role/permissions. */
export interface UpdateCompanyMemberInput {
  role?: CompanyRole;
  permissions?: CompanyPermission[];
}

/**
 * Courier domain DTOs for Moovo.
 *
 * A `Courier` is the public-facing identity of an individual courier ("Glovo
 * mode"), backed by an Oxy user account (`oxyUserId`); display fields are
 * denormalized onto the DTO so the frontend renders directly without a second
 * lookup. A `Vehicle` is a child entity owned EITHER by a courier or a company.
 * Display name / username / avatar are NEVER stored in the Moovo-owned
 * `CourierProfile` — they are read live from the Oxy profile at hydration time.
 */

/** A delivery job category. */
export type JobType = 'package' | 'food' | 'move';

/** Coarse parcel/cargo size class. */
export type SizeClass = 'small' | 'medium' | 'large';

/** A vehicle category a courier can operate. */
export type VehicleType = 'bike' | 'scooter' | 'car' | 'van' | 'truck';

/** Lifecycle/verification status of a courier profile. */
export type CourierStatus = 'pending' | 'active' | 'suspended';

/** Real-time availability of a courier. */
export type OnlineStatus = 'online' | 'offline' | 'on_job';

/** A GeoJSON point; coordinates are `[lng, lat]`. */
export interface GeoPoint {
  type: 'Point';
  /** `[lng, lat]` per GeoJSON. */
  coordinates: [number, number];
}

/** Physical bounding dimensions, in centimetres. */
export interface DimensionsCm {
  /** Length, cm. */
  l: number;
  /** Width, cm. */
  w: number;
  /** Height, cm. */
  h: number;
}

/** The computed capability envelope of a vehicle (what jobs it may serve). */
export interface CourierCapability {
  /** Job types this vehicle is eligible for. */
  eligibleJobTypes: JobType[];
  /** Largest parcel size class this vehicle can carry. */
  maxSizeClass: SizeClass;
  /** Maximum payload weight, kilograms. */
  maxWeightKg: number;
}

/** Carrying capacity of a vehicle. */
export interface VehicleCapacity {
  /** Maximum payload weight, kilograms. */
  maxWeightKg: number;
  /** Maximum cargo volume, litres. */
  maxVolumeL?: number;
  /** Maximum cargo bounding dimensions, centimetres. */
  maxDimsCm?: DimensionsCm;
}

/** A vehicle a courier or company operates. */
export interface Vehicle {
  /** Stable vehicle id. */
  id: string;
  /** Whether the vehicle is owned by an individual courier or a company. */
  ownerType: 'courier' | 'company';
  /** Owning courier's Oxy user id (when `ownerType === 'courier'`). */
  courierOxyUserId?: string;
  /** Owning company id (when `ownerType === 'company'`). */
  companyId?: string;
  /** Vehicle category. */
  type: VehicleType;
  /** Optional human label (e.g. "Red Vespa"). */
  label?: string;
  /** Optional registration plate. */
  plate?: string;
  /** Carrying capacity. */
  capacity: VehicleCapacity;
  /** Denormalized at write from the capability table for this `type`. */
  eligibleJobTypes: JobType[];
  /** Lifecycle status. */
  status: 'active' | 'inactive';
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/** Payload accepted when creating a vehicle. */
export interface CreateVehicleInput {
  /** Vehicle category. */
  type: VehicleType;
  /** Optional human label. */
  label?: string;
  /** Optional registration plate. */
  plate?: string;
  /** Optional capacity overrides; weight defaults from the capability table. */
  capacity?: {
    maxWeightKg?: number;
    maxVolumeL?: number;
    maxDimsCm?: DimensionsCm;
  };
}

/** Payout configuration for a courier or company (Oxy Pay). */
export interface CourierPayout {
  /** Payout provider. */
  provider: 'oxy_pay';
  /** Opaque provider account reference, when linked. */
  accountRef?: string;
}

/**
 * The Moovo-owned aggregates + denormalized capability cache of an individual
 * courier, keyed by their Oxy user id. Identity (name/avatar) is NOT stored
 * here — it is read live from Oxy at hydration time.
 */
export interface CourierProfile {
  /** Stable profile id (Moovo-scoped). */
  id: string;
  /** Owning Oxy user account id. */
  oxyUserId: string;
  /** Lifecycle/verification status. */
  status: CourierStatus;
  /** Real-time availability. */
  onlineStatus: OnlineStatus;
  /** Last known location (GeoJSON point), when the courier has pinged. */
  currentLocation?: GeoPoint;
  /** ISO-8601 time of the last location ping. */
  lastPingAt?: string;
  /** Ids of the vehicles this courier owns. */
  vehicleIds: string[];
  /** Id of the currently-active vehicle, when one is selected. */
  activeVehicleId?: string;
  /** Denormalized from the active vehicle: job types this courier can serve. */
  eligibleJobTypes: JobType[];
  /** Denormalized from the active vehicle: max payload weight, kilograms. */
  maxWeightKg: number;
  /** Denormalized from the active vehicle: largest carriable size class. */
  maxSizeClass: SizeClass;
  /** Aggregate rating, 0–5. */
  rating: number;
  /** Number of reviews contributing to `rating`. */
  reviewCount: number;
  /** Number of completed jobs. */
  completedJobs: number;
  /** Number of cancelled jobs. */
  cancelledJobs: number;
  /** Share of offered jobs accepted, 0–1, when computed. */
  acceptanceRate?: number;
  /** Payout configuration. */
  payout: CourierPayout;
  /** Company this courier belongs to, when part of a fleet. */
  companyId?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/** Public courier identity attached to jobs/listings (Oxy-backed). */
export interface Courier {
  /** Stable courier id (Moovo-scoped). */
  id: string;
  /** Owning Oxy user account id. */
  oxyUserId: string;
  /** Canonical display name (from the Oxy profile contract). */
  displayName: string;
  /** Oxy username/handle, without the leading `@`. */
  username: string;
  /** Avatar file id resolvable via the Oxy media CDN, when present. */
  avatar?: string | null;
  /** Lifecycle/verification status. */
  status: CourierStatus;
  /** Real-time availability. */
  onlineStatus: OnlineStatus;
  /** Job types this courier can currently serve (from the active vehicle). */
  eligibleJobTypes: JobType[];
  /** Aggregate rating in the range 0–5, when the courier has reviews. */
  rating?: number;
  /** Total number of reviews contributing to `rating`. */
  reviewCount?: number;
}

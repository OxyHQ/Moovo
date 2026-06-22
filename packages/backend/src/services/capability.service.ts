/**
 * Vehicle capability engine (PURE — no I/O).
 *
 * A declarative table (`VEHICLE_RULES`) maps each `VehicleType` to the job types
 * it can serve, the largest parcel size class it can carry, and a default max
 * payload weight. `computeVehicleCapability` projects a type onto its capability
 * envelope; `isEligible` tests a concrete job request against a capability. This
 * module owns the eligibility rules in ONE place so both the vehicle write-path
 * (denormalizing `eligibleJobTypes`) and the courier capability cache derive from
 * the same source of truth.
 */

import type { JobType, SizeClass, VehicleType, CourierCapability } from '@moovo/shared-types';

/** Default max payload weight per vehicle type, kilograms. */
const BIKE_MAX_WEIGHT_KG = 10;
const SCOOTER_MAX_WEIGHT_KG = 20;
const CAR_MAX_WEIGHT_KG = 100;
const VAN_MAX_WEIGHT_KG = 800;
const TRUCK_MAX_WEIGHT_KG = 3500;

/**
 * The declarative capability rules per vehicle type. Source of truth for both
 * the denormalized vehicle `eligibleJobTypes` and the courier capability cache.
 */
export const VEHICLE_RULES: Record<
  VehicleType,
  { jobTypes: JobType[]; maxSizeClass: SizeClass; maxWeightKg: number }
> = {
  bike: { jobTypes: ['package', 'food'], maxSizeClass: 'small', maxWeightKg: BIKE_MAX_WEIGHT_KG },
  scooter: {
    jobTypes: ['package', 'food'],
    maxSizeClass: 'small',
    maxWeightKg: SCOOTER_MAX_WEIGHT_KG,
  },
  car: { jobTypes: ['package', 'food'], maxSizeClass: 'medium', maxWeightKg: CAR_MAX_WEIGHT_KG },
  van: { jobTypes: ['package'], maxSizeClass: 'large', maxWeightKg: VAN_MAX_WEIGHT_KG },
  truck: { jobTypes: ['package', 'move'], maxSizeClass: 'large', maxWeightKg: TRUCK_MAX_WEIGHT_KG },
};

/** Ordinal ordering of size classes (small < medium < large) for comparisons. */
const SIZE_ORDER: Record<SizeClass, number> = { small: 0, medium: 1, large: 2 };

/**
 * Project a vehicle `type` onto its capability envelope. The returned
 * `eligibleJobTypes` is a fresh array (never the rule's array reference) so
 * callers may persist it without aliasing the table.
 */
export function computeVehicleCapability(type: VehicleType): CourierCapability {
  const rule = VEHICLE_RULES[type];
  return {
    eligibleJobTypes: [...rule.jobTypes],
    maxSizeClass: rule.maxSizeClass,
    maxWeightKg: rule.maxWeightKg,
  };
}

/**
 * Whether a `capability` can serve a concrete job request: the job type must be
 * eligible, the requested size class must not exceed the carriable maximum, and
 * the weight must not exceed the payload limit.
 */
export function isEligible(
  capability: CourierCapability,
  req: { jobType: JobType; sizeClass: SizeClass; weightKg: number },
): boolean {
  if (!capability.eligibleJobTypes.includes(req.jobType)) {
    return false;
  }
  if (SIZE_ORDER[req.sizeClass] > SIZE_ORDER[capability.maxSizeClass]) {
    return false;
  }
  return req.weightKg <= capability.maxWeightKg;
}

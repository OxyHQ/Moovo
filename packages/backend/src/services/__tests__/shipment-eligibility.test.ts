/**
 * Unit tests for shipment-vs-vehicle eligibility (PURE — no I/O).
 *
 * Reuses the `capability.service` `isEligible` engine — the SINGLE source of the
 * eligibility rules — against a job request derived from a shipment's
 * `ParcelDetails` + type. Asserts that a courier's vehicle capability correctly
 * accepts/rejects concrete shipments (job-type fit, oversize, overweight).
 */

import { describe, it, expect } from 'vitest';
import type { ParcelDetails, ShipmentType, JobType } from '@moovo/shared-types';
import { computeVehicleCapability, isEligible } from '../capability.service.js';

/** Derive the eligibility request from a shipment's type + parcel details. */
function requestFor(type: ShipmentType, parcel: ParcelDetails): {
  jobType: JobType;
  sizeClass: ParcelDetails['sizeClass'];
  weightKg: number;
} {
  return { jobType: type, sizeClass: parcel.sizeClass, weightKg: parcel.weightKg };
}

describe('shipment-vs-capability eligibility', () => {
  it('a bike can serve a small, light food shipment', () => {
    const cap = computeVehicleCapability('bike');
    const parcel: ParcelDetails = { weightKg: 3, sizeClass: 'small', pieces: 1 };
    expect(isEligible(cap, requestFor('food', parcel))).toBe(true);
  });

  it('a bike cannot serve a move shipment (job type ineligible)', () => {
    const cap = computeVehicleCapability('bike');
    const parcel: ParcelDetails = { weightKg: 3, sizeClass: 'small', pieces: 1 };
    expect(isEligible(cap, requestFor('move', parcel))).toBe(false);
  });

  it('a car cannot serve a large package (oversize beyond medium)', () => {
    const cap = computeVehicleCapability('car');
    const parcel: ParcelDetails = { weightKg: 10, sizeClass: 'large', pieces: 1 };
    expect(isEligible(cap, requestFor('package', parcel))).toBe(false);
  });

  it('a bike cannot serve an overweight package', () => {
    const cap = computeVehicleCapability('bike');
    const parcel: ParcelDetails = { weightKg: cap.maxWeightKg + 1, sizeClass: 'small', pieces: 1 };
    expect(isEligible(cap, requestFor('package', parcel))).toBe(false);
  });

  it('a truck can serve a large, heavy move shipment', () => {
    const cap = computeVehicleCapability('truck');
    const parcel: ParcelDetails = { weightKg: 2000, sizeClass: 'large', pieces: 5 };
    expect(isEligible(cap, requestFor('move', parcel))).toBe(true);
  });

  it('a van serves a large package but not a food shipment', () => {
    const cap = computeVehicleCapability('van');
    const largePackage: ParcelDetails = { weightKg: 200, sizeClass: 'large', pieces: 2 };
    const food: ParcelDetails = { weightKg: 2, sizeClass: 'small', pieces: 1 };
    expect(isEligible(cap, requestFor('package', largePackage))).toBe(true);
    expect(isEligible(cap, requestFor('food', food))).toBe(false);
  });
});

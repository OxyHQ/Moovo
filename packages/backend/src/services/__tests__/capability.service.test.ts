/**
 * Unit tests for the PURE `capability.service` vehicle eligibility engine.
 *
 * No DB/I/O — asserts each vehicle type's computed capability envelope and the
 * `isEligible` rule across job-type mismatch, oversized parcels, overweight
 * loads, and boundary (equality) cases.
 */

import { describe, it, expect } from 'vitest';
import type { CourierCapability } from '@moovo/shared-types';
import { computeVehicleCapability, isEligible, VEHICLE_RULES } from '../capability.service.js';

describe('capability.service computeVehicleCapability', () => {
  it('maps bike/scooter to package+food, small', () => {
    for (const type of ['bike', 'scooter'] as const) {
      const cap = computeVehicleCapability(type);
      expect(cap.eligibleJobTypes).toEqual(['package', 'food']);
      expect(cap.maxSizeClass).toBe('small');
      expect(cap.maxWeightKg).toBe(VEHICLE_RULES[type].maxWeightKg);
    }
  });

  it('maps car to package+food, medium', () => {
    const cap = computeVehicleCapability('car');
    expect(cap.eligibleJobTypes).toEqual(['package', 'food']);
    expect(cap.maxSizeClass).toBe('medium');
  });

  it('maps van to package only, large', () => {
    const cap = computeVehicleCapability('van');
    expect(cap.eligibleJobTypes).toEqual(['package']);
    expect(cap.maxSizeClass).toBe('large');
  });

  it('maps truck to package+move, large', () => {
    const cap = computeVehicleCapability('truck');
    expect(cap.eligibleJobTypes).toEqual(['package', 'move']);
    expect(cap.maxSizeClass).toBe('large');
  });

  it('returns a fresh array, not the rule reference', () => {
    const cap = computeVehicleCapability('bike');
    expect(cap.eligibleJobTypes).not.toBe(VEHICLE_RULES.bike.jobTypes);
    cap.eligibleJobTypes.push('move');
    expect(VEHICLE_RULES.bike.jobTypes).toEqual(['package', 'food']);
  });
});

describe('capability.service isEligible', () => {
  const carCap: CourierCapability = computeVehicleCapability('car');

  it('accepts an in-envelope request', () => {
    expect(isEligible(carCap, { jobType: 'food', sizeClass: 'small', weightKg: 5 })).toBe(true);
  });

  it('rejects an ineligible job type', () => {
    expect(isEligible(carCap, { jobType: 'move', sizeClass: 'small', weightKg: 5 })).toBe(false);
  });

  it('rejects an oversized parcel', () => {
    expect(isEligible(carCap, { jobType: 'package', sizeClass: 'large', weightKg: 5 })).toBe(false);
  });

  it('rejects an overweight load', () => {
    const overweight = carCap.maxWeightKg + 1;
    expect(
      isEligible(carCap, { jobType: 'package', sizeClass: 'small', weightKg: overweight }),
    ).toBe(false);
  });

  it('accepts at the exact size and weight boundary', () => {
    expect(
      isEligible(carCap, {
        jobType: 'package',
        sizeClass: carCap.maxSizeClass,
        weightKg: carCap.maxWeightKg,
      }),
    ).toBe(true);
  });

  it('truck can serve a large move job', () => {
    const truckCap = computeVehicleCapability('truck');
    expect(isEligible(truckCap, { jobType: 'move', sizeClass: 'large', weightKg: 3000 })).toBe(true);
  });
});

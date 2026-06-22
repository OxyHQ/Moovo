/**
 * Unit tests for the PURE `pricing.service` internal-quote engine.
 *
 * No DB/I/O — asserts the FAIR breakdown is correct (every component a
 * non-negative integer, components sum to total), that distance scales the
 * distance component, and that size class scales the size component. Rates are
 * read from the live `config.pricing` defaults.
 */

import { describe, it, expect } from 'vitest';
import { computeInternalQuote } from '../pricing.service.js';
import { config } from '../../config/index.js';

/** Sum the present components of a breakdown (FAIR minor units). */
function componentSum(b: ReturnType<typeof computeInternalQuote>): number {
  return (
    b.base.fairMinor +
    b.distance.fairMinor +
    b.size.fairMinor +
    (b.surge?.fairMinor ?? 0) +
    (b.fees?.fairMinor ?? 0)
  );
}

describe('pricing.service computeInternalQuote — FAIR breakdown correctness', () => {
  it('every component is a non-negative integer and components sum to total', () => {
    const b = computeInternalQuote({ distanceM: 5000, sizeClass: 'medium', type: 'package' });
    for (const money of [b.base, b.distance, b.size, b.total]) {
      expect(Number.isInteger(money.fairMinor)).toBe(true);
      expect(money.fairMinor).toBeGreaterThanOrEqual(0);
    }
    expect(b.total.fairMinor).toBe(componentSum(b));
  });

  it('stores FAIR as the original currency on every component', () => {
    const b = computeInternalQuote({ distanceM: 1000, sizeClass: 'small', type: 'food' });
    for (const money of [b.base, b.distance, b.size, b.total]) {
      expect(money.originalCurrency).toBe('FAIR');
    }
  });

  it('uses the configured base fare for the shipment type', () => {
    const b = computeInternalQuote({ distanceM: 0, sizeClass: 'small', type: 'move' });
    expect(b.base.fairMinor).toBe(config.pricing.baseFairMinor.move);
  });

  it('includes the service fee component only when configured > 0', () => {
    const b = computeInternalQuote({ distanceM: 0, sizeClass: 'small', type: 'package' });
    if (config.pricing.serviceFeeFairMinor > 0) {
      expect(b.fees?.fairMinor).toBe(config.pricing.serviceFeeFairMinor);
    } else {
      expect(b.fees).toBeUndefined();
    }
  });
});

describe('pricing.service computeInternalQuote — scaling', () => {
  it('distance scaling: more distance ⇒ higher distance component and total', () => {
    const near = computeInternalQuote({ distanceM: 1000, sizeClass: 'small', type: 'package' });
    const far = computeInternalQuote({ distanceM: 10000, sizeClass: 'small', type: 'package' });
    expect(far.distance.fairMinor).toBeGreaterThan(near.distance.fairMinor);
    expect(far.total.fairMinor).toBeGreaterThan(near.total.fairMinor);
  });

  it('distance component equals perKm × km, rounded', () => {
    const b = computeInternalQuote({ distanceM: 5000, sizeClass: 'small', type: 'package' });
    expect(b.distance.fairMinor).toBe(Math.round(config.pricing.perKmFairMinor * 5));
  });

  it('size scaling: a larger size class never costs less than a smaller one', () => {
    const small = computeInternalQuote({ distanceM: 3000, sizeClass: 'small', type: 'package' });
    const medium = computeInternalQuote({ distanceM: 3000, sizeClass: 'medium', type: 'package' });
    const large = computeInternalQuote({ distanceM: 3000, sizeClass: 'large', type: 'package' });
    expect(medium.size.fairMinor).toBeGreaterThanOrEqual(small.size.fairMinor);
    expect(large.size.fairMinor).toBeGreaterThanOrEqual(medium.size.fairMinor);
    expect(large.total.fairMinor).toBeGreaterThanOrEqual(small.total.fairMinor);
  });

  it('zero distance yields a zero distance component', () => {
    const b = computeInternalQuote({ distanceM: 0, sizeClass: 'small', type: 'package' });
    expect(b.distance.fairMinor).toBe(0);
  });
});

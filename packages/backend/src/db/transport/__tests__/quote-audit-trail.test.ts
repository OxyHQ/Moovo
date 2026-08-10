/**
 * The guard that keeps `quotes`' single audit pair honest, and the measurement
 * that justified the single pair in the first place.
 *
 * `quotes` stores ONE `original_currency` and ONE `original_amount` for a price
 * breakdown that has SIX `FairMoney` components, each carrying its own optional
 * pair. That is lossless only while every producer writes the same value to all
 * six, which is true today and is not a property anyone should have to remember.
 *
 * So this file has two halves, and they cover different failure modes on
 * purpose — neither substitutes for the other:
 *
 *  - **The guard's own cases.** `collapseAuditTrail` refuses divergence, so a
 *    producer that does not exist yet is covered. Adapters are the pluggable
 *    part of this system — every external carrier is one — and the realistic
 *    way this breaks is a carrier that quotes in EUR, written by somebody who
 *    never reads this file.
 *  - **A measurement of today's producers.** The guard would let a UNIFORMLY
 *    non-FAIR breakdown through, because one currency for all six components is
 *    exactly what the column can store. That is correct, and it means the guard
 *    alone cannot tell anybody that `pricing.service` has started quoting in
 *    EUR — which is a decision that should be noticed, not absorbed. The second
 *    half asserts the two current writers really do emit `'FAIR'`, so the day
 *    one changes, a test goes red naming it.
 */

import { describe, it, expect } from 'vitest';
import type { PriceBreakdown, ShipmentType, SizeClass } from '@moovo/shared-types';
import { collapseAuditTrail } from '../quoteRepository';
import { computeInternalQuote } from '../../../services/pricing.service';
import { buildMockAdapters } from '../../../services/providers/adapters/mock-provider';
import type { ShipmentRecord } from '../shipmentShape';

/** Every component present, all agreeing on `currency`. */
function uniform(currency: 'FAIR' | 'EUR' | 'USD' | undefined): PriceBreakdown {
  const money = (fairMinor: number) =>
    currency === undefined ? { fairMinor } : { fairMinor, originalCurrency: currency };
  return {
    base: money(100),
    distance: money(200),
    size: money(50),
    surge: money(25),
    fees: money(10),
    total: money(385),
  };
}

describe('collapseAuditTrail — the single pair is guarded, not merely documented', () => {
  it('collapses six agreeing FAIR components to one stored currency', () => {
    expect(collapseAuditTrail(uniform('FAIR'))).toEqual({ originalCurrency: 'FAIR' });
  });

  it('collapses a breakdown where no component names a currency to null', () => {
    expect(collapseAuditTrail(uniform(undefined))).toEqual({ originalCurrency: null });
  });

  /**
   * A UNIFORMLY non-FAIR breakdown is storable and is deliberately allowed.
   *
   * The column holds one currency; it does not hold one PARTICULAR currency.
   * Refusing EUR here would be this function enforcing a pricing policy it has
   * no business knowing about — the thing it exists to prevent is a breakdown
   * whose six components disagree, because that is the one shape a single
   * column cannot represent.
   */
  it('allows a uniformly non-FAIR breakdown, which the single column can hold', () => {
    expect(collapseAuditTrail(uniform('EUR'))).toEqual({ originalCurrency: 'EUR' });
  });

  it('refuses a breakdown whose components disagree, naming the components', () => {
    const mixed = uniform('FAIR');
    mixed.distance = { fairMinor: 200, originalCurrency: 'EUR' };

    expect(() => collapseAuditTrail(mixed)).toThrow(/disagree on originalCurrency/);
    // The message must name the offending component, or an operator reading a
    // 500 has to diff two adapters by hand to find which one moved.
    expect(() => collapseAuditTrail(mixed)).toThrow(/distance=EUR/);
  });

  it('refuses when one component names a currency and the others are silent', () => {
    const partial = uniform(undefined);
    partial.total = { fairMinor: 385, originalCurrency: 'FAIR' };

    // Absent is not the same as FAIR: storing 'FAIR' here would assert an audit
    // fact about five components that never claimed one.
    expect(() => collapseAuditTrail(partial)).toThrow(/disagree on originalCurrency/);
  });

  /**
   * `originalAmount` is refused outright, and the reason is a column TYPE
   * mismatch rather than a modelling preference.
   *
   * `quotes.original_amount` is `moneyMinor()` — `bigint`, integer MINOR units —
   * while `FairMoney.originalAmount` is documented as a decimal MAJOR unit
   * (`9.99` for 9.99 EUR). A decimal is rejected by the server outright and an
   * integer is silently wrong by the currency's precision. Nothing writes it
   * today, which is exactly why the mismatch has never been noticed.
   */
  it('refuses any component that sets originalAmount, naming the type mismatch', () => {
    const withAmount = uniform('EUR');
    withAmount.base = { fairMinor: 100, originalCurrency: 'EUR', originalAmount: 9.99 };

    expect(() => collapseAuditTrail(withAmount)).toThrow(/originalAmount on base/);
    expect(() => collapseAuditTrail(withAmount)).toThrow(/bigint minor units/);
  });

  it('ignores absent optional components rather than treating them as a disagreement', () => {
    const minimal: PriceBreakdown = {
      base: { fairMinor: 100, originalCurrency: 'FAIR' },
      distance: { fairMinor: 200, originalCurrency: 'FAIR' },
      size: { fairMinor: 50, originalCurrency: 'FAIR' },
      total: { fairMinor: 350, originalCurrency: 'FAIR' },
    };
    expect(collapseAuditTrail(minimal)).toEqual({ originalCurrency: 'FAIR' });
  });

  /**
   * The optional components are actually REACHED.
   *
   * Without this case every assertion above would pass against a function that
   * only ever looked at the four required components — `surge` and `fees` are
   * precisely where a divergence would hide, since they are the components a
   * carrier adds.
   */
  it('checks surge and fees too, not only the four required components', () => {
    const surgeDiffers = uniform('FAIR');
    surgeDiffers.surge = { fairMinor: 25, originalCurrency: 'USD' };
    expect(() => collapseAuditTrail(surgeDiffers)).toThrow(/surge=USD/);

    const feesDiffer = uniform('FAIR');
    feesDiffer.fees = { fairMinor: 10, originalCurrency: 'USD' };
    expect(() => collapseAuditTrail(feesDiffer)).toThrow(/fees=USD/);
  });
});

/** A shipment with two endpoints far enough apart to price a distance component. */
function shipmentFor(type: ShipmentType, sizeClass: SizeClass): ShipmentRecord {
  return {
    id: 'shipment-audit',
    senderOxyUserId: 'sender-audit',
    type,
    status: 'quoting',
    pickup: {
      location: { type: 'Point', coordinates: [2.1734, 41.3851] },
      address: { line1: 'a', city: 'Barcelona', postalCode: '08001', country: 'ES' },
      contactName: 'A',
      contactPhone: '1',
    },
    dropoff: {
      location: { type: 'Point', coordinates: [2.2, 41.4] },
      address: { line1: 'b', city: 'Barcelona', postalCode: '08002', country: 'ES' },
      contactName: 'B',
      contactPhone: '2',
    },
    parcel: { weightKg: 2, sizeClass, pieces: 1 },
    itemDescription: 'a box',
    photos: [],
    scheduling: { kind: 'now' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Every component of a breakdown, with its name, including the optional ones. */
function components(breakdown: PriceBreakdown): Array<[string, { originalCurrency?: string; originalAmount?: number }]> {
  const entries: Array<[string, { originalCurrency?: string; originalAmount?: number }]> = [
    ['base', breakdown.base],
    ['distance', breakdown.distance],
    ['size', breakdown.size],
    ['total', breakdown.total],
  ];
  if (breakdown.surge) entries.push(['surge', breakdown.surge]);
  if (breakdown.fees) entries.push(['fees', breakdown.fees]);
  return entries;
}

describe('the producers this decision was measured against', () => {
  const types: ShipmentType[] = ['package', 'food', 'move'];
  const sizes: SizeClass[] = ['small', 'medium', 'large'];

  it('pricing.service emits one currency across every component, for every type and size', () => {
    for (const type of types) {
      for (const sizeClass of sizes) {
        const breakdown = computeInternalQuote({ distanceM: 4_200, sizeClass, type });
        const currencies = new Set(components(breakdown).map(([, m]) => m.originalCurrency));

        expect(
          currencies,
          `pricing.service now emits mixed originalCurrency for ${type}/${sizeClass}. ` +
            'quotes stores ONE pair per breakdown — see quoteRepository.collapseAuditTrail. ' +
            'This needs six per-component columns and a migration, not a wider guard.',
        ).toEqual(new Set(['FAIR']));
      }
    }
  });

  it('pricing.service sets originalAmount on no component', () => {
    for (const type of types) {
      for (const sizeClass of sizes) {
        const breakdown = computeInternalQuote({ distanceM: 4_200, sizeClass, type });
        const withAmount = components(breakdown).filter(([, m]) => m.originalAmount !== undefined);

        expect(
          withAmount.map(([name]) => name),
          'quotes.original_amount is bigint MINOR units and FairMoney.originalAmount is a ' +
            'decimal MAJOR unit; writing one needs the column type corrected first.',
        ).toEqual([]);
      }
    }
  });

  it('every registered mock carrier emits one currency across every component', async () => {
    const adapters = buildMockAdapters();
    // A vacuity floor: an empty adapter list would make the loop below assert
    // nothing while reporting a pass.
    expect(adapters.length).toBeGreaterThan(0);

    for (const adapter of adapters) {
      const quotes = await adapter.quote(shipmentFor('package', 'small'));
      expect(quotes.length, `${adapter.key} produced no quote to check`).toBeGreaterThan(0);

      for (const quote of quotes) {
        const currencies = new Set(
          components(quote.priceBreakdown).map(([, m]) => m.originalCurrency),
        );
        expect(
          currencies,
          `adapter ${adapter.key} now emits mixed originalCurrency. See collapseAuditTrail.`,
        ).toEqual(new Set(['FAIR']));
      }
    }
  });

  /**
   * The two halves meet: what the producers emit is what the guard accepts.
   *
   * Asserted by running a real produced breakdown through the guard rather than
   * by inspecting it, so the two cannot drift into agreeing about different
   * things.
   */
  it('a real pricing.service breakdown passes the guard and collapses to FAIR', () => {
    const breakdown = computeInternalQuote({ distanceM: 4_200, sizeClass: 'medium', type: 'move' });
    expect(collapseAuditTrail(breakdown)).toEqual({ originalCurrency: 'FAIR' });
  });
});

/**
 * What a jury may see of a delivery.
 *
 * The central test is {@link forbiddenValuesNeverAppear}: every piece of PII a
 * `Job` carries is seeded with a unique sentinel, and the assertion is that NONE
 * of them appears anywhere in the serialised output. That shape is chosen
 * deliberately over asserting the presence of a known-good field list — a
 * whitelist test passes happily when somebody adds a leaking field, because the
 * fields it checks are all still correct. Searching the whole output for values
 * that must not be there fails on a field nobody thought to write a test for,
 * which is the only kind of leak that actually happens.
 */

import { describe, it, expect } from 'vitest';
import type { IShipmentEndpoint } from '../../../models/shipment.js';
import { boundedText, coarseLocationLabel, note, redactEndpoint } from '../subjects/redaction.js';

/** Sentinels chosen so a substring search cannot match them by accident. */
const PII = {
  contactName: 'ZZCONTACTNAMEZZ',
  contactPhone: '+34ZZPHONEZZ999',
  line1: 'ZZSTREETLINEONEZZ 42',
  line2: 'ZZFLATTWOZZ',
  postalCode: 'ZZ08ZZ01',
} as const;

const SAFE = {
  city: 'Barcelona',
  region: 'Catalunya',
  country: 'ES',
  notes: 'Ring the bell twice',
} as const;

function endpoint(overrides: Partial<IShipmentEndpoint> = {}): IShipmentEndpoint {
  return {
    location: { type: 'Point', coordinates: [2.154007, 41.390205] },
    address: {
      line1: PII.line1,
      line2: PII.line2,
      city: SAFE.city,
      region: SAFE.region,
      postalCode: PII.postalCode,
      country: SAFE.country,
    },
    contactName: PII.contactName,
    contactPhone: PII.contactPhone,
    notes: SAFE.notes,
    ...overrides,
  };
}

describe('redactEndpoint', () => {
  it('emits only a coarse place label and the user-authored notes', () => {
    expect(redactEndpoint(endpoint())).toEqual({
      locationLabel: 'Barcelona, Catalunya, ES',
      notes: SAFE.notes,
    });
  });

  describe('forbiddenValuesNeverAppear', () => {
    const serialised = JSON.stringify(redactEndpoint(endpoint()));

    for (const [field, value] of Object.entries(PII)) {
      it(`never carries ${field}`, () => {
        expect(serialised).not.toContain(value);
      });
    }

    /**
     * Coordinates are DROPPED, not coarsened.
     *
     * The contract would accept two decimal places, so this is Moovo's own
     * stricter choice and needs its own assertion: a delivery has two endpoints,
     * and a pair of 1.1 km squares plus a timestamp narrows a household much
     * further than either square alone. Asserting on the leading digits catches a
     * rounded value as well as a precise one — a test for the exact original
     * number would pass the moment somebody "fixed" the leak by rounding it.
     */
    it('never carries coordinates, coarsened or otherwise', () => {
      expect(serialised).not.toContain('41.39');
      expect(serialised).not.toContain('2.15');
      expect(serialised).not.toContain('41.4');
      expect(serialised).not.toContain('coordinates');
    });
  });

  it('omits a label entirely when there is nothing safe to say', () => {
    const anonymous = endpoint({
      address: { line1: PII.line1, city: '', postalCode: PII.postalCode, country: '' },
    });
    expect(redactEndpoint(anonymous).locationLabel).toBeUndefined();
  });

  it('treats a missing endpoint as empty rather than throwing', () => {
    expect(redactEndpoint(undefined)).toEqual({});
  });

  it('omits blank notes rather than sending an empty string', () => {
    // The contract rejects an empty text resource, and `''` would otherwise read
    // as though the user had written something.
    expect(redactEndpoint(endpoint({ notes: '   ' })).notes).toBeUndefined();
  });
});

describe('coarseLocationLabel', () => {
  it('deduplicates a city-state so the label does not repeat itself', () => {
    expect(
      coarseLocationLabel({
        line1: PII.line1,
        city: 'Singapore',
        region: 'Singapore',
        postalCode: PII.postalCode,
        country: 'Singapore',
      }),
    ).toBe('Singapore');
  });

  it('excludes the postal code even though it looks coarse', () => {
    // A full postcode covers a single street in much of Europe and a handful of
    // houses in the UK — a street address wearing a different shape.
    const label = coarseLocationLabel({
      line1: PII.line1,
      city: SAFE.city,
      postalCode: 'SW1A 1AA',
      country: SAFE.country,
    });
    expect(label).toBe('Barcelona, ES');
    expect(label).not.toContain('SW1A');
  });

  it('returns undefined for a missing address', () => {
    expect(coarseLocationLabel(undefined)).toBeUndefined();
  });
});

describe('boundedText', () => {
  it('bounds an over-long value', () => {
    expect(boundedText('x'.repeat(500), 200)).toHaveLength(200);
  });

  it('treats blank as absent so it can be omitted rather than sent empty', () => {
    expect(boundedText('   ', 200)).toBeUndefined();
    expect(boundedText(undefined, 200)).toBeUndefined();
  });
});

describe('note', () => {
  it('bounds a note so one delivery cannot dominate a case', () => {
    expect(note('y'.repeat(5_000))).toHaveLength(1_000);
  });
});

/**
 * What a jury may see of a delivery.
 *
 * The central test is {@link forbiddenValuesNeverAppear}: every piece of PII a
 * delivery carries is seeded with a unique sentinel, and the assertion is that
 * NONE of them appears anywhere in the serialised output. That shape is chosen
 * deliberately over asserting the presence of a known-good field list — a
 * whitelist test passes happily when somebody adds a leaking field, because the
 * fields it checks are all still correct. Searching the whole output for values
 * that must not be there fails on a field nobody thought to write a test for,
 * which is the only kind of leak that actually happens.
 *
 * ## Why the fixtures go in through a cast
 *
 * `CoarsePlace` has no `line1`, `contactPhone` or `postalCode` member, so a
 * caller writing one out cannot compile — the strongest form of this guarantee,
 * and one a runtime test cannot express. What the TYPE cannot see is the route a
 * real leak takes: somebody SPREADS a wider row into the call, and the extra
 * keys ride along invisibly. The single assertion below reproduces exactly that,
 * which is why the sentinels are still worth seeding: it proves `redactEndpoint`
 * builds its own object rather than passing its input through.
 */

import { describe, it, expect } from 'vitest';
import {
  boundedText,
  coarseLocationLabel,
  note,
  redactEndpoint,
  type CoarsePlace,
} from '../subjects/redaction.js';

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

/** A place as a caller may legally describe it. */
function endpoint(overrides: Partial<CoarsePlace> = {}): CoarsePlace {
  return { city: SAFE.city, region: SAFE.region, country: SAFE.country, notes: SAFE.notes, ...overrides };
}

/**
 * The same place plus every forbidden field, as a caller that spread a wider row
 * would produce.
 *
 * The assertion is deliberately a DOWNCAST rather than a literal: a literal
 * naming `line1` is a compile error, which is the point of the type and is not
 * something a runtime test can observe. This reproduces the one shape the type
 * cannot refuse, and `redactEndpoint` must still emit nothing from it.
 */
function leakyEndpoint(): CoarsePlace {
  const spreadFromAWiderRow: Record<string, unknown> = {
    ...endpoint(),
    ...PII,
    location: { type: 'Point', coordinates: [2.154007, 41.390205] },
  };
  return spreadFromAWiderRow as CoarsePlace;
}

describe('redactEndpoint', () => {
  it('emits only a coarse place label and the user-authored notes', () => {
    expect(redactEndpoint(endpoint())).toEqual({
      locationLabel: 'Barcelona, Catalunya, ES',
      notes: SAFE.notes,
    });
  });

  describe('forbiddenValuesNeverAppear', () => {
    const serialised = JSON.stringify(redactEndpoint(leakyEndpoint()));

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
    const anonymous = endpoint({ city: '', region: '', country: '' });
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
      coarseLocationLabel({ city: 'Singapore', region: 'Singapore', country: 'Singapore' }),
    ).toBe('Singapore');
  });

  it('excludes the postal code even though it looks coarse', () => {
    // A full postcode covers a single street in much of Europe and a handful of
    // houses in the UK — a street address wearing a different shape. It has no
    // member on `CoarsePlace` at all, so this goes in the way a real one would:
    // spread from a wider row, past the type.
    const withPostcode: Record<string, unknown> = {
      city: SAFE.city,
      country: SAFE.country,
      postalCode: 'SW1A 1AA',
    };
    const label = coarseLocationLabel(withPostcode as CoarsePlace);
    expect(label).toBe('Barcelona, ES');
    expect(label).not.toContain('SW1A');
  });

  it('returns undefined for a missing place', () => {
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

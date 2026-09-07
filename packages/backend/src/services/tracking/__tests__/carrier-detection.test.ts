/**
 * Detection — the half of this product that decides whether a pasted string
 * becomes a tracked parcel or a shrug.
 *
 * Two properties are asserted rather than the implementation:
 *
 * **Normalisation agrees with the database.** `normalizeTrackingNumber` and
 * `tracked_parcels_number_normalised_check` are two spellings of one rule, and
 * the cost of them drifting is not an error — it is a second identity for one
 * parcel, with its own schedule and its own bill. The realdb half of this pair
 * lives in `db/__tests__/tracking-schema.realdb.test.ts`; here we pin the
 * function's own contract.
 *
 * **A wrong auto-pick is worse than a question.** `resolveDetection` may only
 * commit when the evidence is decisive, because guessing wrong means polling a
 * carrier that never had the parcel and showing "no information" forever —
 * indistinguishable, from the user's seat, from a carrier being down.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectCarriers,
  normalizeTrackingNumber,
  resolveDetection,
  s10CheckDigitValid,
  upsCheckDigitValid,
} from '../carrier-detection.js';
import { registerBuiltInTrackingAdapters } from '../register-tracking-adapters.js';
import { __resetTrackingRegistryForTests } from '../tracking-registry.js';

beforeEach(() => {
  __resetTrackingRegistryForTests();
  registerBuiltInTrackingAdapters();
});

describe('normalizeTrackingNumber', () => {
  it('strips the separators a carrier prints and a user pastes', () => {
    expect(normalizeTrackingNumber('1Z999AA1-0123456784')).toBe('1Z999AA10123456784');
    expect(normalizeTrackingNumber(' 1z 999 aa1 0123456784 ')).toBe('1Z999AA10123456784');
  });

  it('is idempotent, which is what lets every write path call it blindly', () => {
    const once = normalizeTrackingNumber('rr 123-456 785 es');
    expect(normalizeTrackingNumber(once)).toBe(once);
    expect(once).toBe('RR123456785ES');
  });

  it('produces only characters the CHECK constraint accepts', () => {
    const out = normalizeTrackingNumber('¿¡ab-12/34 CD ñ ✈');
    expect(out).toBe('AB1234CD');
    expect(out).toBe(out.toUpperCase());
    expect(/[^A-Z0-9]/.test(out)).toBe(false);
  });
});

describe('check digits', () => {
  it('accepts a genuine S10 number and rejects a mistyped check digit', () => {
    expect(s10CheckDigitValid('RR123456785ES')).toBe(true);
    expect(s10CheckDigitValid('EE123456785DE')).toBe(true);
    // Same number, check digit off by one — the single most common typo, and
    // the whole reason a checksum beats a shape match.
    expect(s10CheckDigitValid('RR123456780ES')).toBe(false);
  });

  it('rejects an S10-shaped string that is not S10-shaped enough', () => {
    expect(s10CheckDigitValid('RR12345678ES')).toBe(false);
    expect(s10CheckDigitValid('1Z999AA10123456784')).toBe(false);
  });

  it('accepts a genuine UPS number and rejects a mistyped one', () => {
    expect(upsCheckDigitValid('1Z999AA10123456784')).toBe(true);
    expect(upsCheckDigitValid('1Z999AA10123456785')).toBe(false);
  });

  it('handles the letters inside a UPS identifier, not just the digits', () => {
    // Letters carry a value too; treating them as zero would pass numbers that
    // differ only in their letters.
    expect(upsCheckDigitValid('1ZA2345678901234B5')).toBe(true);
  });
});

describe('detectCarriers', () => {
  it('identifies a UPS number by its check digit', () => {
    const [best] = detectCarriers('1Z999AA1 0123456784');
    expect(best?.carrierKey).toBe('ups');
    expect(best?.checksumPassed).toBe(true);
  });

  it('routes an S10 number to the postal operator its country suffix names', () => {
    expect(detectCarriers('RR123456785ES')[0]?.carrierKey).toBe('correos');
    expect(detectCarriers('RR100000003GB')[0]?.carrierKey).toBe('royal-mail');
    expect(detectCarriers('RR100000003DE')[0]?.carrierKey).toBe('deutsche-post');
  });

  it('ranks a passing check digit above a bare shape match', () => {
    const candidates = detectCarriers('RR123456785ES');
    expect(candidates[0]?.checksumPassed).toBe(true);
    const failing = candidates.filter((candidate) => !candidate.checksumPassed);
    for (const candidate of failing) {
      expect(candidates.indexOf(candidate)).toBeGreaterThan(0);
    }
  });

  it('returns nothing for a string no carrier claims', () => {
    expect(detectCarriers('hola')).toEqual([]);
    expect(detectCarriers('')).toEqual([]);
  });

  it('claims a bare 12-digit number for FedEx and a 10-digit one for DHL', () => {
    expect(detectCarriers('123456789012').map((c) => c.carrierKey)).toContain('fedex');
    expect(detectCarriers('1234567890').map((c) => c.carrierKey)).toContain('dhl-express');
  });

  it('never claims a number for a carrier with no detection rule', () => {
    // SEUR, GLS and Amazon are picked by hand. A rule that fired on anything
    // would make every number ambiguous and every add a question — worse than
    // no rule at all.
    const everything = [
      ...detectCarriers('1Z999AA10123456784'),
      ...detectCarriers('RR123456785ES'),
      ...detectCarriers('123456789012'),
      ...detectCarriers('1234567890'),
    ].map((candidate) => candidate.carrierKey);
    expect(everything).not.toContain('seur');
    expect(everything).not.toContain('gls');
    expect(everything).not.toContain('amazon');
  });

  it('claims a USPS IMpb label, and stops FedEx from being the silent answer', () => {
    // A 22-digit `9405…` number is USPS. FedEx's `\d{22}` shape rule claims it
    // too, and before `usps` existed FedEx was the ONLY claimant, so it was
    // picked with no question asked and the parcel would have shown "no
    // information" forever while Moovo polled a carrier that never had it.
    const keys = detectCarriers('9405511899223197428490').map((c) => c.carrierKey);
    expect(keys).toContain('usps');
    expect(keys).toContain('fedex');
  });

  it('ASKS for a 22-digit number rather than guessing between USPS and FedEx', () => {
    // The consequence of the entry above, stated as the behaviour a user sees.
    // Neither carrier has a check digit implemented, so nothing breaks the tie
    // and the picker is the honest answer.
    const resolved = resolveDetection(detectCarriers('9405511899223197428490'));
    expect(resolved.carrierKey).toBeNull();
    expect(resolved.candidates.length).toBeGreaterThan(1);
  });

  it('routes an S10 number with a US suffix to USPS', () => {
    expect(resolveDetection(detectCarriers('RR123456785US')).carrierKey).toBe('usps');
  });

  it('identifies OnTrac and Veho by prefixes nothing else claims', () => {
    expect(resolveDetection(detectCarriers('C12345678901234')).carrierKey).toBe('ontrac');
    expect(resolveDetection(detectCarriers('D12345678901234')).carrierKey).toBe('ontrac');
    expect(resolveDetection(detectCarriers('1LS7238391823')).carrierKey).toBe('veho');
  });

  it('never claims a number for the Spanish carriers that are picked by hand', () => {
    // Correos Express, MRW, Nacex, CTT, DHL Parcel, Paack, Envialia, Tipsa and
    // Zeleris all use bare digit runs that collide with each other and with
    // Correos' own domestic format. A rule per carrier would make every numeric
    // Spanish parcel ambiguous — a worse product than the picker.
    const byHand = [
      'correos-express',
      'mrw',
      'nacex',
      'ctt-express',
      'dhl-parcel',
      'paack',
      'envialia',
      'tipsa',
      'zeleris',
      'dhl-ecommerce',
    ];
    const everything = [
      ...detectCarriers('1Z999AA10123456784'),
      ...detectCarriers('RR123456785ES'),
      ...detectCarriers('123456789012'),
      ...detectCarriers('1234567890'),
      ...detectCarriers('9405511899223197428490'),
      ...detectCarriers('PQ123456789'),
    ].map((candidate) => candidate.carrierKey);
    for (const key of byHand) expect(everything).not.toContain(key);
  });

  it('never claims a number for the internal moovo carrier', () => {
    // A Moovo parcel is created by BOOKING, never by pasting: its row is a
    // pointer at a job. Detecting one from a number would let anyone conjure a
    // pointer with no job behind it.
    const everything = [
      ...detectCarriers('MOV000042'),
      ...detectCarriers('1234567890'),
    ].map((candidate) => candidate.carrierKey);
    expect(everything).not.toContain('moovo');
  });
});

describe('resolveDetection', () => {
  it('commits when only one carrier claimed the number', () => {
    const resolved = resolveDetection([{ carrierKey: 'ups', checksumPassed: false, score: 50 }]);
    expect(resolved.carrierKey).toBe('ups');
  });

  it('commits when several claimed it but exactly one passed a check digit', () => {
    const resolved = resolveDetection([
      { carrierKey: 'correos', checksumPassed: true, score: 100 },
      { carrierKey: 'fedex', checksumPassed: false, score: 35 },
    ]);
    expect(resolved.carrierKey).toBe('correos');
  });

  it('ASKS when two carriers both pass — the case a guess would get wrong', () => {
    const resolved = resolveDetection([
      { carrierKey: 'correos', checksumPassed: true, score: 100 },
      { carrierKey: 'royal-mail', checksumPassed: true, score: 100 },
    ]);
    expect(resolved.carrierKey).toBeNull();
    expect(resolved.candidates).toHaveLength(2);
  });

  it('ASKS when several match on shape alone', () => {
    const resolved = resolveDetection([
      { carrierKey: 'fedex', checksumPassed: false, score: 35 },
      { carrierKey: 'dhl-express', checksumPassed: false, score: 40 },
    ]);
    expect(resolved.carrierKey).toBeNull();
  });

  it('commits to nothing when nobody claimed it', () => {
    expect(resolveDetection([]).carrierKey).toBeNull();
  });
});

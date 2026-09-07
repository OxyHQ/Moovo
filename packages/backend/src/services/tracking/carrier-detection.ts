/**
 * Working out whose number this is — pure, no I/O, no database.
 *
 * ## Normalisation has exactly one spelling
 *
 * {@link normalizeTrackingNumber} is exported once and used by the detector,
 * the lookup, the subscribe path, the webhook and the re-point. It is also the
 * expression `tracked_parcels_number_normalised_check` encodes. Two spellings
 * of "normalised" is precisely how the CHECK and the detector come to disagree,
 * and the symptom is not an error — it is a second identity for one parcel,
 * with its own poll schedule and its own carrier bill.
 *
 * ## Detection returns CANDIDATES, never an answer
 *
 * Silently picking the wrong carrier means polling it forever and showing the
 * user "no information", which is indistinguishable from a carrier being down.
 * So this ranks and returns; {@link resolveDetection} says when the ranking is
 * decisive enough to act on without asking.
 *
 * ## Where a checksum exists, it is what separates detecting from guessing
 *
 * A shape match is weak — `\d{12}` matches a great many things. A check digit
 * is strong. Two are implemented here because both can be demonstrated against
 * a known-good number, and a carrier whose check digit is NOT implemented
 * reports `checksumPassed: false` rather than a guess. That direction is
 * deliberate: `checksumPassed` is what {@link resolveDetection} uses to break a
 * tie, so a checksum that is wrong in the optimistic direction auto-picks the
 * wrong carrier, while one that is merely absent only asks a question.
 */

import type { TrackingDetectionHint } from './tracking-adapter.js';
import { listTrackingAdapters } from './tracking-registry.js';

/**
 * Uppercase, and strip everything that is not `A-Z0-9`.
 *
 * Carriers print their numbers with spaces and hyphens, so a paste carries
 * them; the database refuses them. This is the one function that reconciles
 * the two, and the CHECK constraint is written to accept exactly its output.
 */
export function normalizeTrackingNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The UPU S10 check digit — weights 8,6,4,2,3,5,9,7 over the first eight
 * digits, mod 11, with 10 folding to 0 and 11 to 5.
 *
 * One rule covers essentially every national postal operator (Correos, Royal
 * Mail, Deutsche Post, USPS international …), which is why it earns its place
 * ahead of any single carrier's.
 */
export function s10CheckDigitValid(normalised: string): boolean {
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalised)) return false;
  const digits = normalised.slice(2, 11);
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    sum += Number(digits[i]) * weights[i]!;
  }
  const remainder = sum % 11;
  let expected = 11 - remainder;
  if (expected === 10) expected = 0;
  else if (expected === 11) expected = 5;
  return Number(digits[8]) === expected;
}

/**
 * The UPS 1Z check digit.
 *
 * Letters take the value `(charCode - 63) % 10` (so `A` is 2), odd positions
 * count once and even positions twice, and the check digit completes the total
 * to a multiple of ten.
 */
export function upsCheckDigitValid(normalised: string): boolean {
  if (!/^1Z[0-9A-Z]{16}$/.test(normalised)) return false;
  const body = normalised.slice(2, 17);
  const check = normalised.slice(17);
  let odd = 0;
  let even = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    const value = char >= '0' && char <= '9' ? Number(char) : (char.charCodeAt(0) - 63) % 10;
    if (i % 2 === 0) odd += value;
    else even += value;
  }
  const total = odd + even * 2;
  return (10 - (total % 10)) % 10 === Number(check);
}

/** One carrier the detector thinks the number might belong to. */
export interface CarrierCandidate {
  carrierKey: string;
  checksumPassed: boolean;
  score: number;
}

/**
 * Every registered carrier that claims this number, best first.
 *
 * Ordering: checksum passers ahead of shape-only matches, then by the adapter's
 * own score, then by whether the carrier serves the caller's country — a
 * tie-break rather than a filter, because a Spanish user tracking a parcel from
 * China is entirely ordinary.
 */
export function detectCarriers(
  raw: string,
  hint?: { country?: string; carrierCountries?: Record<string, readonly string[]> },
): CarrierCandidate[] {
  const normalised = normalizeTrackingNumber(raw);
  if (normalised.length < 4) return [];

  const country = hint?.country?.toUpperCase();
  const candidates: CarrierCandidate[] = [];

  for (const adapter of listTrackingAdapters()) {
    const claim: TrackingDetectionHint | null = adapter.detect?.(normalised) ?? null;
    if (!claim) continue;
    candidates.push({
      carrierKey: adapter.key,
      checksumPassed: claim.checksumPassed,
      score: claim.score,
    });
  }

  return candidates.sort((a, b) => {
    if (a.checksumPassed !== b.checksumPassed) return a.checksumPassed ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (country) {
      const aServes = hint?.carrierCountries?.[a.carrierKey]?.includes(country) ?? false;
      const bServes = hint?.carrierCountries?.[b.carrierKey]?.includes(country) ?? false;
      if (aServes !== bServes) return aServes ? -1 : 1;
    }
    return a.carrierKey.localeCompare(b.carrierKey);
  });
}

/**
 * Whether the ranking is decisive enough to act on without asking the user.
 *
 * Decisive in exactly two cases: only one carrier claimed the number at all, or
 * several claimed it and exactly one of them passed a check digit. Anything
 * else is a question, because the cost of guessing is a parcel that shows "no
 * information" forever while we poll a carrier that never had it.
 */
export function resolveDetection(candidates: CarrierCandidate[]): {
  carrierKey: string | null;
  candidates: CarrierCandidate[];
} {
  if (candidates.length === 0) return { carrierKey: null, candidates };
  if (candidates.length === 1) return { carrierKey: candidates[0]!.carrierKey, candidates };
  const passers = candidates.filter((candidate) => candidate.checksumPassed);
  if (passers.length === 1) return { carrierKey: passers[0]!.carrierKey, candidates };
  return { carrierKey: null, candidates };
}

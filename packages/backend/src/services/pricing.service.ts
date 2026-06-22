/**
 * Internal Moovo-courier pricing engine (PURE — no I/O).
 *
 * Computes a FAIR {@link PriceBreakdown} for a shipment fulfilled by a Moovo
 * courier from three inputs: the great-circle distance, the parcel size class and
 * the shipment type. Every component is computed directly in FAIR minor units
 * (integers) — FAIR is the stored source of truth, so there is no fiat conversion
 * here. Tunable rates live in `config.pricing` (read at module load); the only
 * module constants are pure unit conversions.
 *
 * `total` = base + distance + size (+ fees when configured). No magic numbers:
 * every rate is named/config-sourced.
 */

import type { FairMoney, PriceBreakdown, ShipmentType, SizeClass } from '@moovo/shared-types';
import { config } from '../config/index.js';

/** Metres per kilometre (the distance rate is per-kilometre). */
const METERS_PER_KM = 1000;

/** The inputs the internal pricing engine prices off of. */
export interface InternalQuoteInput {
  /** Great-circle pickup→dropoff distance, metres. */
  distanceM: number;
  /** Coarse parcel size class. */
  sizeClass: SizeClass;
  /** What is being moved. */
  type: ShipmentType;
}

/** Wrap a FAIR minor-unit integer in a `FairMoney` value (FAIR is the source of truth). */
function fair(fairMinor: number): FairMoney {
  return { fairMinor, originalCurrency: 'FAIR' };
}

/**
 * Compute the FAIR price breakdown for an internal Moovo-courier quote.
 *
 * - `base`     — flat fare for the shipment type (`config.pricing.baseFairMinor`).
 * - `distance` — `perKmFairMinor × (distanceM / 1000)`, rounded to whole minor units.
 * - `size`     — additive size-class surcharge (`config.pricing.sizeSurchargeFairMinor`).
 * - `fees`     — flat service fee, included only when configured > 0.
 * - `total`    — sum of the present components.
 *
 * All components are clamped to non-negative integers.
 */
export function computeInternalQuote(input: InternalQuoteInput): PriceBreakdown {
  const baseFairMinor = config.pricing.baseFairMinor[input.type];
  const distanceKm = Math.max(0, input.distanceM) / METERS_PER_KM;
  const distanceFairMinor = Math.round(config.pricing.perKmFairMinor * distanceKm);
  const sizeFairMinor = config.pricing.sizeSurchargeFairMinor[input.sizeClass];
  const feesFairMinor = config.pricing.serviceFeeFairMinor;

  const totalFairMinor = baseFairMinor + distanceFairMinor + sizeFairMinor + feesFairMinor;

  const breakdown: PriceBreakdown = {
    base: fair(baseFairMinor),
    distance: fair(distanceFairMinor),
    size: fair(sizeFairMinor),
    total: fair(totalFairMinor),
  };
  if (feesFairMinor > 0) {
    breakdown.fees = fair(feesFairMinor);
  }
  return breakdown;
}

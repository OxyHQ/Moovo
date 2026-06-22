/**
 * FAIR → DisplayMoney projection helpers (PURE — no I/O).
 *
 * The stored source of truth is always FAIR (`fairMinor`). At the API boundary,
 * a `FairMoney`/`FairMoney`-priced breakdown is projected to {@link DisplayMoney}
 * carrying BOTH the FAIR amount and a converted display amount (in a chosen fiat
 * currency, when a rate is available). The fiat conversion uses `fairToFiat` from
 * `faircoin-rate.service`; the rate is fetched ONCE per request and threaded in
 * here, so this module performs no network I/O.
 */

import type {
  FairMoney,
  DisplayMoney,
  FairRate,
  PriceBreakdown,
  DisplayPriceBreakdown,
  FiatCurrency,
} from '@moovo/shared-types';
import { FAIR_MINOR_UNITS } from '@moovo/shared-types';
import { fairToFiat } from '../services/faircoin-rate.service.js';

/** Default display currency when the caller does not request one. */
export const DEFAULT_DISPLAY_CURRENCY: FiatCurrency = 'EUR';

/** The set of fiat display currencies a request may select. */
const FIAT_CURRENCIES: readonly FiatCurrency[] = ['EUR', 'USD'];

/**
 * Resolve a requested display currency string to a supported fiat currency,
 * falling back to {@link DEFAULT_DISPLAY_CURRENCY}. `FAIR` (or anything
 * unrecognised) yields the default fiat currency for the display projection;
 * callers that want FAIR-only display simply ignore the `display` field.
 */
export function resolveDisplayCurrency(requested?: string): FiatCurrency {
  if (requested && (FIAT_CURRENCIES as readonly string[]).includes(requested)) {
    return requested as FiatCurrency;
  }
  return DEFAULT_DISPLAY_CURRENCY;
}

/**
 * Project a FAIR amount to {@link DisplayMoney}, converting to `rate.currency`
 * when a rate is supplied. With no rate the `display` field is omitted (FAIR-only).
 */
export function toDisplayMoney(money: FairMoney, rate: FairRate | undefined): DisplayMoney {
  const fairMinor = money.fairMinor;
  const dto: DisplayMoney = {
    fairMinor,
    fair: fairMinor / FAIR_MINOR_UNITS,
  };
  if (rate) {
    dto.display = { amount: fairToFiat(fairMinor, rate), currency: rate.currency };
    dto.rate = rate;
  }
  return dto;
}

/** Project a FAIR `PriceBreakdown` to a {@link DisplayPriceBreakdown} at `rate`. */
export function toDisplayPriceBreakdown(
  breakdown: PriceBreakdown,
  rate: FairRate | undefined,
): DisplayPriceBreakdown {
  const dto: DisplayPriceBreakdown = {
    base: toDisplayMoney(breakdown.base, rate),
    distance: toDisplayMoney(breakdown.distance, rate),
    size: toDisplayMoney(breakdown.size, rate),
    total: toDisplayMoney(breakdown.total, rate),
  };
  if (breakdown.surge) {
    dto.surge = toDisplayMoney(breakdown.surge, rate);
  }
  if (breakdown.fees) {
    dto.fees = toDisplayMoney(breakdown.fees, rate);
  }
  return dto;
}

import { FAIR_SYMBOL, type DisplayMoney } from "@moovo/shared-types";

/**
 * Money formatting for the courier surface.
 *
 * All Moovo prices are stored in FairCoin (FAIR); the API returns a
 * {@link DisplayMoney} that carries the canonical FAIR amount AND an optional
 * converted fiat display amount. The UI renders the converted display amount in
 * its fiat currency when present, otherwise the FAIR major amount with the FAIR
 * glyph (⊜). We never invent fields or recompute the price — we render exactly
 * what the API serialized.
 */

/** Minor units shown after the decimal point for fiat display amounts. */
const FIAT_FRACTION_DIGITS = 2;

/**
 * Format a {@link DisplayMoney} for display. Prefers the converted fiat amount
 * (`12.50 EUR`) when the API supplied one, else the canonical FAIR amount
 * (`⊜12.5`). Returns a plain string ready to drop into a `<Text>`.
 */
export function formatDisplayMoney(money: DisplayMoney): string {
  if (money.display) {
    const amount = money.display.amount.toLocaleString(undefined, {
      minimumFractionDigits: FIAT_FRACTION_DIGITS,
      maximumFractionDigits: FIAT_FRACTION_DIGITS,
    });
    return `${amount} ${money.display.currency}`;
  }
  return `${FAIR_SYMBOL}${money.fair}`;
}

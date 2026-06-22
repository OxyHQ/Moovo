/**
 * FAIR money display helpers for the Moovo customer app.
 *
 * Every Moovo price is a FAIR {@link DisplayMoney} value: the canonical FAIR
 * amount plus an optional converted fiat display amount. The UI renders the FAIR
 * glyph (⊜) with the FAIR major amount, and — when the API attached a converted
 * `display` — the fiat equivalent alongside it. Storage stays FAIR; these helpers
 * only format, never recompute the price.
 */

import { FAIR_SYMBOL, type DisplayMoney, type FiatCurrency } from '@moovo/shared-types';

/** ISO-4217 → locale currency symbol for the fiat display amount. */
const FIAT_SYMBOLS: Record<FiatCurrency, string> = {
  EUR: '€',
  USD: '$',
};

/** Format the canonical FAIR amount, e.g. `⊜ 12.50`. */
export function formatFair(money: Pick<DisplayMoney, 'fair'>): string {
  return `${FAIR_SYMBOL} ${money.fair.toFixed(2)}`;
}

/** Format only the converted fiat amount, e.g. `€6.13`, or `null` when absent. */
export function formatFiat(money: Pick<DisplayMoney, 'display'>): string | null {
  if (!money.display) {
    return null;
  }
  const symbol = FIAT_SYMBOLS[money.display.currency];
  return `${symbol}${money.display.amount.toFixed(2)}`;
}

/**
 * Format a {@link DisplayMoney} for inline display: the FAIR amount, with the
 * converted fiat in parentheses when present — e.g. `⊜ 12.50 (€6.13)`.
 */
export function formatDisplayMoney(money: DisplayMoney): string {
  const fiat = formatFiat(money);
  return fiat ? `${formatFair(money)} (${fiat})` : formatFair(money);
}

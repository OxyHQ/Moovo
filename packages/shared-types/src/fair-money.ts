/**
 * FairCoin (FAIR) money contract — the canonical money representation for Moovo.
 *
 * ALL Moovo prices are STORED in FairCoin. FAIR is the official Oxy currency and
 * the single source of truth for any persisted amount. Users and couriers may
 * input or view amounts in a fiat currency (EUR/USD), but those are converted to
 * FAIR on the way in and only the FAIR amount is persisted; on the way out, the
 * stored FAIR amount is converted back to the chosen display currency using the
 * current FAIR↔fiat rate (sourced from the FairCoin Explorer).
 *
 * This is intentionally SEPARATE from the inherited marketplace `Money` DTO
 * (integer minor units in a single fiat `CurrencyCode`). `Money` is retained by
 * the legacy marketplace surfaces until Phase 2 replaces them; `FairMoney` is the
 * money foundation the courier/transport domain is built on.
 *
 * ## Representation & precision
 *
 * A `FairMoney.fairMinor` is an INTEGER count of FAIR minor units, where one FAIR
 * = `FAIR_MINOR_UNITS` (100) minor units, i.e. FAIR is represented with
 * {@link FAIR_DECIMALS} (2) decimal places — e.g. `fairMinor: 1250` = 12.50 FAIR.
 *
 * Integer minor units are used (rather than a float) so the persisted source of
 * truth can never accumulate binary floating-point drift. Two decimals mirror the
 * rest of the Oxy ecosystem, where FAIR balances are displayed with two decimals
 * (`@oxyhq/accounts` `formatFairCoinBalance` → `toFixed(2)`; the Oxy wallet
 * `balance` is a 2-decimal number) and matches the inherited `Money` convention
 * of integer minor units.
 */

/**
 * Number of decimal places FAIR is represented with. One FAIR is split into
 * `10 ** FAIR_DECIMALS` minor units.
 */
export const FAIR_DECIMALS = 2;

/**
 * Minor units per whole FAIR (`10 ** FAIR_DECIMALS`). `fairMinor` is an integer
 * count of these — e.g. `100` = 1.00 FAIR, `1250` = 12.50 FAIR.
 */
export const FAIR_MINOR_UNITS = 100;

/** The FairCoin currency glyph, matching the rest of the Oxy ecosystem. */
export const FAIR_SYMBOL = '⊜';

/** ISO-4217 currency code reserved for FAIR in display/audit shapes. */
export const FAIR_CURRENCY = 'FAIR';

/**
 * Currencies a user/courier may input or view amounts in. `FAIR` is the stored
 * source of truth; `EUR`/`USD` are display/input currencies that get converted
 * to and from FAIR. New fiat display currencies are added here.
 */
export type SupportedCurrency = 'FAIR' | 'EUR' | 'USD';

/**
 * A fiat display/input currency — the subset of {@link SupportedCurrency} that
 * is NOT FAIR. These are the currencies a FAIR amount can be converted to/from.
 */
export type FiatCurrency = Exclude<SupportedCurrency, 'FAIR'>;

/**
 * The canonical Moovo money value. `fairMinor` (integer FAIR minor units) is the
 * SOURCE OF TRUTH and the only field that is persisted as the price.
 *
 * `originalCurrency` / `originalAmount` are an OPTIONAL audit trail capturing
 * what the user actually entered before conversion (e.g. a courier set a price of
 * `9.99 EUR`). They exist for traceability only — never recompute the price from
 * them; always use `fairMinor`.
 */
export interface FairMoney {
  /**
   * Amount in integer FAIR minor units (one FAIR = {@link FAIR_MINOR_UNITS}).
   * The source of truth — `1250` = 12.50 FAIR. Always an integer.
   */
  fairMinor: number;
  /**
   * The currency the amount was originally entered/quoted in, for audit. When
   * the user entered the amount directly in FAIR this is `'FAIR'`.
   */
  originalCurrency?: SupportedCurrency;
  /**
   * The amount as originally entered, in `originalCurrency`'s natural unit (a
   * decimal major unit — e.g. `9.99` for `9.99 EUR`, or `12.5` for `12.50 FAIR`),
   * for audit. Never used to recompute the price.
   */
  originalAmount?: number;
}

/**
 * The FAIR↔fiat rate used for a conversion, echoed back on API output so clients
 * can show the rate that was applied and when it was sourced.
 */
export interface FairRate {
  /** The fiat currency this rate converts FAIR to/from. */
  currency: FiatCurrency;
  /**
   * Price of ONE FAIR in `currency`'s major unit — e.g. `0.49` means 1 FAIR =
   * 0.49 of `currency`. Multiply FAIR by this to get fiat; divide fiat by this to
   * get FAIR.
   */
  fiatPerFair: number;
  /** ISO-8601 timestamp of when the rate was sourced from the Explorer. */
  asOf: string;
  /**
   * Identifier of where the rate came from (e.g. the Explorer pool/source, or a
   * fallback marker). Surfaced for transparency, not used in math.
   */
  source: string;
}

/**
 * API output money shape: carries the stored FAIR amount (source of truth) AND a
 * display amount converted into a chosen fiat currency at a known rate. Clients
 * render `display.amount` in `display.currency`; the FAIR fields remain the
 * canonical value.
 */
export interface DisplayMoney {
  /** Source-of-truth FAIR amount in integer minor units. */
  fairMinor: number;
  /** The FAIR amount as a decimal major unit (e.g. `12.5`), for convenience. */
  fair: number;
  /**
   * The converted display amount. Absent when the chosen display currency is
   * FAIR itself (the FAIR fields already carry it) or when no rate was available
   * to convert.
   */
  display?: {
    /** Display amount in `currency`'s major unit (e.g. `6.13` EUR). */
    amount: number;
    /** The fiat currency the amount is expressed in. */
    currency: FiatCurrency;
  };
  /** The rate applied to produce `display`, when a fiat conversion occurred. */
  rate?: FairRate;
}

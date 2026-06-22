/**
 * FairCoin (FAIR) rate service — the money foundation for Moovo pricing.
 *
 * ALL Moovo prices are STORED in FAIR (the canonical {@link FairMoney} value);
 * fiat amounts are only ever an input/display projection. This service is the
 * single source of the current FAIR↔fiat rate and the pure conversion math the
 * rest of the backend uses to move between FAIR minor units and a fiat major
 * unit.
 *
 * ## Rate source
 *
 * The live rate comes from the FairCoin Explorer (`explorer.fairco.in`) price endpoint:
 *
 *     GET {config.faircoin.explorerApiUrl}/api/price
 *     → { "price": 0.49, "change24h": null, "volume24h": 0,
 *         "liquidityUsd": 2454.13, "marketCapUsd": null,
 *         "source": "wfair-usdc-pool", "updatedAt": "2026-…Z" }
 *
 * `price` is the USD price of ONE FAIR (the Explorer prices FAIR against a
 * USDC pool — confirmed by `liquidityUsd`/`source`). The Explorer does NOT serve
 * EUR, so the EUR price of FAIR is derived: `eurPerFair = usdPerFair ×
 * config.faircoin.usdToEurRate`.
 *
 * ## Caching & resilience
 *
 * The USD price is fetched at most once per {@link AppConfig.faircoin.rateCacheTtlMs}
 * and held in-memory. If a refresh fails (network/timeout/bad shape) the last
 * good cached price is reused; if there is no cached price yet, the configured
 * `fallbackUsdPerFair` is used so a conversion never throws on a transient
 * Explorer outage. The fallback is NEVER the primary source — a live fetch always
 * takes precedence and replaces it. All fetch/parse failures are logged (never
 * silently swallowed).
 */

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import {
  FAIR_MINOR_UNITS,
  type FairRate,
  type FiatCurrency,
} from '@moovo/shared-types';

const log = createLogger('faircoin-rate');

/** Path appended to the configured Explorer base URL to read the FAIR price. */
const EXPLORER_PRICE_PATH = '/api/price';

/** Marker `source` used on a `FairRate` when the configured fallback price was used. */
const FALLBACK_SOURCE = 'moovo-fallback';

/**
 * The subset of the Explorer `/api/price` response this service relies on. The
 * Explorer returns more fields (`change24h`, `volume24h`, `liquidityUsd`,
 * `marketCapUsd`); only `price` (USD per FAIR), `source` and `updatedAt` are
 * consumed here.
 */
interface ExplorerPriceResponse {
  /** USD price of one FAIR. */
  price: number;
  /** Identifier of the Explorer's price source (e.g. `'wfair-usdc-pool'`). */
  source?: string;
  /** ISO-8601 timestamp the Explorer last refreshed the price. */
  updatedAt?: string;
}

/** An in-memory snapshot of the last successfully sourced USD-per-FAIR price. */
interface CachedUsdPrice {
  /** USD price of one FAIR. */
  usdPerFair: number;
  /** Explorer-reported source identifier for this price. */
  source: string;
  /** Explorer-reported timestamp for this price (ISO-8601). */
  asOf: string;
  /** Monotonic `Date.now()` at which this snapshot was cached, for TTL checks. */
  cachedAtMs: number;
}

/**
 * Module-level cache. `null` until the first successful fetch (or the first
 * fallback materialization). Replaced wholesale on each successful refresh.
 */
let cache: CachedUsdPrice | null = null;

/** In-flight refresh, deduped so concurrent reads share ONE Explorer request. */
let inFlight: Promise<CachedUsdPrice> | null = null;

/**
 * Narrow an unknown JSON value to the Explorer price shape we depend on. Requires
 * a finite, positive `price`; `source`/`updatedAt` are optional strings.
 */
function isExplorerPriceResponse(value: unknown): value is ExplorerPriceResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.price === 'number' && Number.isFinite(record.price) && record.price > 0;
}

/** Whether a cached price is still within its TTL relative to `now`. */
function isFresh(snapshot: CachedUsdPrice, now: number): boolean {
  return now - snapshot.cachedAtMs < config.faircoin.rateCacheTtlMs;
}

/**
 * Fetch the current USD-per-FAIR price from the Explorer. Throws on any
 * network/timeout/HTTP/parse failure (callers decide how to fall back).
 */
async function fetchUsdPriceFromExplorer(): Promise<CachedUsdPrice> {
  const url = `${config.faircoin.explorerApiUrl}${EXPLORER_PRICE_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.faircoin.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Explorer responded ${response.status} ${response.statusText}`);
    }

    const body: unknown = await response.json();
    if (!isExplorerPriceResponse(body)) {
      throw new Error('Explorer price response missing a finite positive `price`');
    }

    return {
      usdPerFair: body.price,
      source: typeof body.source === 'string' && body.source.length > 0 ? body.source : 'explorer',
      asOf:
        typeof body.updatedAt === 'string' && body.updatedAt.length > 0
          ? body.updatedAt
          : new Date().toISOString(),
      cachedAtMs: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return a USD-per-FAIR snapshot, refreshing from the Explorer when the cache is
 * empty or stale. On a failed refresh the last good cache is reused; if there is
 * none, the configured fallback price is materialized into the cache so future
 * reads are served without re-hitting a known-down Explorer until the TTL lapses.
 * Concurrent callers during a refresh share one in-flight request.
 */
async function getUsdPriceSnapshot(): Promise<CachedUsdPrice> {
  const now = Date.now();
  if (cache && isFresh(cache, now)) {
    return cache;
  }

  if (!inFlight) {
    inFlight = fetchUsdPriceFromExplorer()
      .then((fresh) => {
        cache = fresh;
        return fresh;
      })
      .catch((err: unknown) => {
        if (cache) {
          log.warn(
            { err, usdPerFair: cache.usdPerFair },
            'FairCoin Explorer rate refresh failed; reusing last cached price',
          );
          return cache;
        }
        const fallback: CachedUsdPrice = {
          usdPerFair: config.faircoin.fallbackUsdPerFair,
          source: FALLBACK_SOURCE,
          asOf: new Date().toISOString(),
          cachedAtMs: Date.now(),
        };
        cache = fallback;
        log.error(
          { err, fallbackUsdPerFair: fallback.usdPerFair },
          'FairCoin Explorer rate fetch failed with no cached price; using configured fallback',
        );
        return fallback;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** Price of one FAIR in `currency`'s major unit, derived from the USD price. */
function fiatPerFairFor(currency: FiatCurrency, usdPerFair: number): number {
  switch (currency) {
    case 'USD':
      return usdPerFair;
    case 'EUR':
      return usdPerFair * config.faircoin.usdToEurRate;
  }
}

/**
 * Get the current rate converting FAIR to/from `currency`, refreshing from the
 * Explorer when needed. The returned `fiatPerFair` is the price of one FAIR in
 * `currency`; `source`/`asOf` reflect where and when the underlying USD price
 * came from. Never throws on a transient Explorer failure — it falls back to the
 * cached or configured price.
 */
export async function getFairRate(currency: FiatCurrency): Promise<FairRate> {
  const snapshot = await getUsdPriceSnapshot();
  return {
    currency,
    fiatPerFair: fiatPerFairFor(currency, snapshot.usdPerFair),
    asOf: snapshot.asOf,
    source: snapshot.source,
  };
}

/**
 * Convert a fiat `amount` (major unit, e.g. `9.99` EUR) into FAIR minor units at
 * `rate`, rounded to the nearest minor unit. Pure — no I/O. Throws on a
 * non-finite/negative `amount` or a non-positive rate (which would make the
 * conversion meaningless).
 *
 * @example fiatToFair(9.99, { currency: 'EUR', fiatPerFair: 0.45, … }) // 2220 (= 22.20 FAIR)
 */
export function fiatToFair(amount: number, rate: FairRate): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Fiat amount must be a non-negative finite number, received ${amount}`);
  }
  if (!Number.isFinite(rate.fiatPerFair) || rate.fiatPerFair <= 0) {
    throw new Error(`Rate fiatPerFair must be a positive finite number, received ${rate.fiatPerFair}`);
  }
  const fairMajor = amount / rate.fiatPerFair;
  return Math.round(fairMajor * FAIR_MINOR_UNITS);
}

/**
 * Convert `fairMinor` (integer FAIR minor units) into a fiat `amount` in
 * `rate.currency`'s major unit, rounded to that currency's 2 decimal places.
 * Pure — no I/O. Throws on a non-integer/negative `fairMinor` or a non-positive
 * rate.
 *
 * @example fairToFiat(2220, { currency: 'EUR', fiatPerFair: 0.45, … }) // 9.99
 */
export function fairToFiat(fairMinor: number, rate: FairRate): number {
  if (!Number.isInteger(fairMinor) || fairMinor < 0) {
    throw new Error(`fairMinor must be a non-negative integer, received ${fairMinor}`);
  }
  if (!Number.isFinite(rate.fiatPerFair) || rate.fiatPerFair <= 0) {
    throw new Error(`Rate fiatPerFair must be a positive finite number, received ${rate.fiatPerFair}`);
  }
  const fiat = (fairMinor / FAIR_MINOR_UNITS) * rate.fiatPerFair;
  return Math.round(fiat * 100) / 100;
}

/**
 * Reset the in-memory rate cache. Intended for tests so each case starts from a
 * clean slate; not used by production code paths.
 */
export function __resetFairRateCacheForTests(): void {
  cache = null;
  inFlight = null;
}

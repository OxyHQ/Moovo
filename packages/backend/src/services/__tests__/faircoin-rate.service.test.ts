/**
 * Unit tests for `faircoin-rate.service`.
 *
 * The service reads `config.faircoin.*` at module load (which reads `process.env`)
 * and holds an in-memory rate cache, so each test sets the env it needs, then
 * `vi.resetModules()` + a dynamic `import()` to get a fresh module with a clean
 * cache and the right config. The FairCoin Explorer is mocked via `globalThis.fetch`.
 *
 * Coverage: the live Explorer fetch + USD→FAIR/EUR derivation, EUR↔FAIR↔EUR and
 * USD↔FAIR↔USD round-trips, rounding at FAIR's 2-decimal precision, the pure-math
 * guards, in-memory caching (one fetch within the TTL), the cached-reuse fallback
 * when a refresh fails, and the configured-fallback path when the Explorer is down
 * with no cached price.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const EXPLORER_API_URL = 'https://explorer.test.fairco.in';
const PRICE_URL = `${EXPLORER_API_URL}/api/price`;

/** A well-formed Explorer `/api/price` body with the given USD-per-FAIR price. */
function explorerBody(price: number, overrides: Record<string, unknown> = {}) {
  return {
    price,
    change24h: null,
    volume24h: 0,
    liquidityUsd: 2454.13,
    marketCapUsd: null,
    source: 'wfair-usdc-pool',
    updatedAt: '2026-06-22T17:14:02.275Z',
    ...overrides,
  };
}

/** Build a `fetch` mock that resolves once with an OK JSON response of `body`. */
function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  });
}

/**
 * Load a fresh copy of the service with `config.faircoin` driven by the given env.
 * Resets modules first so `config` re-reads `process.env` and the rate cache is empty.
 */
async function loadService(env: Record<string, string>) {
  process.env.FAIRCOIN_EXPLORER_API_URL = EXPLORER_API_URL;
  process.env.FAIRCOIN_USD_TO_EUR_RATE = '0.9';
  process.env.FAIRCOIN_FALLBACK_USD_PER_FAIR = '0.5';
  process.env.FAIRCOIN_RATE_CACHE_TTL_MS = '300000';
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  vi.resetModules();
  return import('../faircoin-rate.service.js');
}

const ENV_KEYS = [
  'FAIRCOIN_EXPLORER_API_URL',
  'FAIRCOIN_USD_TO_EUR_RATE',
  'FAIRCOIN_FALLBACK_USD_PER_FAIR',
  'FAIRCOIN_RATE_CACHE_TTL_MS',
  'FAIRCOIN_RATE_REQUEST_TIMEOUT_MS',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('getFairRate', () => {
  it('fetches the live USD price from the Explorer /api/price endpoint', async () => {
    const fetchMock = okFetch(explorerBody(0.49));
    vi.stubGlobal('fetch', fetchMock);
    const svc = await loadService({});

    const rate = await svc.getFairRate('USD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(PRICE_URL, expect.objectContaining({ method: 'GET' }));
    expect(rate.currency).toBe('USD');
    expect(rate.fiatPerFair).toBeCloseTo(0.49, 10);
    expect(rate.source).toBe('wfair-usdc-pool');
    expect(rate.asOf).toBe('2026-06-22T17:14:02.275Z');
  });

  it('derives the EUR rate from the USD price via the configured USD→EUR rate', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.5)));
    const svc = await loadService({ FAIRCOIN_USD_TO_EUR_RATE: '0.9' });

    const rate = await svc.getFairRate('EUR');

    // 0.5 USD/FAIR × 0.9 USD→EUR = 0.45 EUR/FAIR.
    expect(rate.currency).toBe('EUR');
    expect(rate.fiatPerFair).toBeCloseTo(0.45, 10);
  });
});

describe('fiatToFair / fairToFiat (pure math)', () => {
  it('round-trips EUR → FAIR → EUR at 2-decimal precision', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.5)));
    const svc = await loadService({ FAIRCOIN_USD_TO_EUR_RATE: '0.9' });
    const rate = await svc.getFairRate('EUR'); // 0.45 EUR/FAIR

    const fairMinor = svc.fiatToFair(9.99, rate);
    // 9.99 / 0.45 = 22.2 FAIR → 2220 minor units.
    expect(fairMinor).toBe(2220);
    expect(Number.isInteger(fairMinor)).toBe(true);

    const back = svc.fairToFiat(fairMinor, rate);
    // 22.20 FAIR × 0.45 = 9.99 EUR exactly.
    expect(back).toBe(9.99);
  });

  it('round-trips USD → FAIR → USD', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.49)));
    const svc = await loadService({});
    const rate = await svc.getFairRate('USD');

    const fairMinor = svc.fiatToFair(12.25, rate);
    const back = svc.fairToFiat(fairMinor, rate);
    // Rounded to FAIR's 2-decimal precision, the round-trip is within one cent.
    expect(Math.abs(back - 12.25)).toBeLessThanOrEqual(0.01);
  });

  it('rounds FAIR minor units to the nearest unit (no fractional minor units)', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.5)));
    const svc = await loadService({ FAIRCOIN_USD_TO_EUR_RATE: '0.9' });
    const rate = await svc.getFairRate('EUR'); // 0.45 EUR/FAIR

    // 1.00 / 0.45 = 2.2222… FAIR → 222.22… minor → rounds to 222.
    expect(svc.fiatToFair(1.0, rate)).toBe(222);
  });

  it('rounds the fiat result to 2 decimals', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.333)));
    const svc = await loadService({});
    const rate = await svc.getFairRate('USD'); // 0.333 USD/FAIR

    // 100 FAIR (10000 minor) × 0.333 = 33.3 → 33.3.
    expect(svc.fairToFiat(10000, rate)).toBe(33.3);
    // 1 FAIR (100 minor) × 0.333 = 0.333 → rounds to 0.33.
    expect(svc.fairToFiat(100, rate)).toBe(0.33);
  });

  it('treats a zero amount as zero in both directions', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.49)));
    const svc = await loadService({});
    const rate = await svc.getFairRate('USD');

    expect(svc.fiatToFair(0, rate)).toBe(0);
    expect(svc.fairToFiat(0, rate)).toBe(0);
  });

  it('rejects invalid inputs instead of silently coercing', async () => {
    vi.stubGlobal('fetch', okFetch(explorerBody(0.49)));
    const svc = await loadService({});
    const rate = await svc.getFairRate('USD');

    expect(() => svc.fiatToFair(-1, rate)).toThrow();
    expect(() => svc.fiatToFair(Number.NaN, rate)).toThrow();
    expect(() => svc.fairToFiat(10.5, rate)).toThrow(); // non-integer minor units
    expect(() => svc.fairToFiat(-1, rate)).toThrow();
    expect(() => svc.fiatToFair(10, { ...rate, fiatPerFair: 0 })).toThrow();
  });
});

describe('caching', () => {
  it('hits the Explorer once within the cache TTL across multiple reads', async () => {
    const fetchMock = okFetch(explorerBody(0.49));
    vi.stubGlobal('fetch', fetchMock);
    const svc = await loadService({ FAIRCOIN_RATE_CACHE_TTL_MS: '300000' });

    await svc.getFairRate('USD');
    await svc.getFairRate('EUR');
    await svc.getFairRate('USD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent reads into a single in-flight Explorer request', async () => {
    const fetchMock = okFetch(explorerBody(0.49));
    vi.stubGlobal('fetch', fetchMock);
    const svc = await loadService({});

    await Promise.all([svc.getFairRate('USD'), svc.getFairRate('EUR'), svc.getFairRate('USD')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fallback path', () => {
  it('uses the configured fallback price when the Explorer fails with no cached price', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const svc = await loadService({
      FAIRCOIN_FALLBACK_USD_PER_FAIR: '0.5',
      FAIRCOIN_USD_TO_EUR_RATE: '0.9',
    });

    const usd = await svc.getFairRate('USD');
    expect(usd.fiatPerFair).toBeCloseTo(0.5, 10);
    expect(usd.source).toBe('moovo-fallback');

    const eur = await svc.getFairRate('EUR');
    expect(eur.fiatPerFair).toBeCloseTo(0.45, 10); // 0.5 × 0.9
  });

  it('reuses the last good cached price when a later refresh fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => explorerBody(0.49),
      })
      .mockRejectedValue(new Error('explorer flaked'));
    vi.stubGlobal('fetch', fetchMock);
    // Zero TTL forces a refresh attempt on the second read.
    const svc = await loadService({ FAIRCOIN_RATE_CACHE_TTL_MS: '0' });

    const first = await svc.getFairRate('USD');
    expect(first.fiatPerFair).toBeCloseTo(0.49, 10);
    expect(first.source).toBe('wfair-usdc-pool');

    const second = await svc.getFairRate('USD');
    // Refresh failed → previous good price reused, NOT the fallback.
    expect(second.fiatPerFair).toBeCloseTo(0.49, 10);
    expect(second.source).toBe('wfair-usdc-pool');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when the Explorer returns a malformed body (no positive price)', async () => {
    vi.stubGlobal('fetch', okFetch({ price: 'not-a-number', source: 'bad' }));
    const svc = await loadService({ FAIRCOIN_FALLBACK_USD_PER_FAIR: '0.5' });

    const rate = await svc.getFairRate('USD');
    expect(rate.fiatPerFair).toBeCloseTo(0.5, 10);
    expect(rate.source).toBe('moovo-fallback');
  });

  it('falls back when the Explorer responds with a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }),
    );
    const svc = await loadService({ FAIRCOIN_FALLBACK_USD_PER_FAIR: '0.5' });

    const rate = await svc.getFairRate('USD');
    expect(rate.fiatPerFair).toBeCloseTo(0.5, 10);
    expect(rate.source).toBe('moovo-fallback');
  });
});

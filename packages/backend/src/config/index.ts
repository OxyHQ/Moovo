/**
 * Application configuration.
 *
 * A typed, frozen object of tunables read from the environment with sane
 * defaults. Every magic number used by the marketplace domain lives here so it
 * can be adjusted per-deployment via env vars without touching code.
 *
 * Values are read ONCE at module load. The object (and its nested groups) is
 * deeply frozen so no code can mutate config at runtime.
 */

/**
 * Parse an integer environment variable, falling back to `fallback` when the
 * variable is unset, empty, or not a finite integer.
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a boolean environment variable. Truthy values are `1`, `true`, `yes`
 * and `on` (case-insensitive); everything else (including unset) yields
 * `fallback`.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Read a non-empty string environment variable, falling back to `fallback` when
 * the variable is unset or empty (after trimming).
 */
function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
}

/**
 * Parse a finite float environment variable, falling back to `fallback` when the
 * variable is unset, empty, or not a finite number.
 */
function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MINUTE_MS = 60_000;

export interface PaginationConfig {
  /** Default page size when the client does not specify a `limit`. */
  readonly defaultPageSize: number;
  /** Hard upper bound on `limit`; larger requests are clamped to this. */
  readonly maxPageSize: number;
}

export interface CatalogConfig {
  /** Maximum number of variants a single product (Listing) may have. */
  readonly maxVariantsPerProduct: number;
  /** Maximum number of gallery images a single listing may have. */
  readonly maxImagesPerListing: number;
}

export interface FeedConfig {
  /** Number of thumbnails shown on a store/merchant card. */
  readonly storeCardThumbnails: number;
}

export interface CartConfig {
  /**
   * Hard upper bound on the quantity of a single variant a cart line may hold.
   * Untracked variants (no inventory ceiling) are clamped to this; tracked
   * variants are additionally clamped to their live `available`.
   */
  readonly maxQuantityPerItem: number;
}

export interface OrdersConfig {
  /**
   * How long an inventory reservation (a `pending_payment` order) is held
   * before the maintenance job may expire it and release the stock.
   */
  readonly reservationTtlMs: number;
  /**
   * Whether the test-only mock-pay endpoint is enabled. Off in production.
   */
  readonly mockPayEnabled: boolean;
  /**
   * Flat shipping cost (integer minor units) for each shipping method, added to
   * the order subtotal at checkout.
   */
  readonly shippingRates: {
    /** Cost of standard shipping. */
    readonly standard: number;
    /** Cost of express shipping. */
    readonly express: number;
    /** Cost of pickup (typically free). */
    readonly pickup: number;
  };
  /**
   * TTL of a checkout idempotency claim in Redis. A replayed checkout within
   * this window returns the original orders instead of creating duplicates.
   */
  readonly idempotencyTtlMs: number;
  /**
   * `available` at or below which a tracked variant counts as "low stock" for
   * the store dashboard's low-stock metric.
   */
  readonly lowStockThreshold: number;
}

export interface FairCoinConfig {
  /**
   * Base URL of the FairCoin Explorer API that serves the current FAIR price.
   * The rate service appends the price path (`/api/price`) to this.
   */
  readonly explorerApiUrl: string;
  /**
   * How long a fetched rate is cached in-memory before the next read triggers a
   * refresh. Keeps the Explorer from being hit on every conversion while still
   * tracking the live rate.
   */
  readonly rateCacheTtlMs: number;
  /**
   * Timeout for a single Explorer price request. A slow Explorer must never hang
   * a conversion; on timeout the service uses its cached/fallback rate.
   */
  readonly requestTimeoutMs: number;
  /**
   * The Explorer prices FAIR in USD only. This is the USD→EUR rate used to derive
   * the EUR price of FAIR (EUR per FAIR = USD per FAIR × this). Sourced from
   * config because the Explorer does not serve EUR; adjust per-deployment.
   */
  readonly usdToEurRate: number;
  /**
   * Last-resort fallback for the USD price of one FAIR, used ONLY when the
   * Explorer is unreachable AND no cached rate exists yet. Never the primary
   * source — the live Explorer rate always takes precedence.
   */
  readonly fallbackUsdPerFair: number;
}

export interface AppConfig {
  readonly pagination: PaginationConfig;
  readonly catalog: CatalogConfig;
  readonly feed: FeedConfig;
  readonly cart: CartConfig;
  readonly orders: OrdersConfig;
  readonly faircoin: FairCoinConfig;
}

/**
 * The single, frozen application config. Import this everywhere instead of
 * inlining magic numbers or reading `process.env` directly for tunables.
 */
export const config: AppConfig = Object.freeze({
  pagination: Object.freeze({
    defaultPageSize: intEnv('PAGE_SIZE_DEFAULT', 20),
    maxPageSize: intEnv('PAGE_SIZE_MAX', 100),
  }),
  catalog: Object.freeze({
    maxVariantsPerProduct: intEnv('MAX_VARIANTS_PER_PRODUCT', 100),
    maxImagesPerListing: intEnv('MAX_IMAGES_PER_LISTING', 12),
  }),
  feed: Object.freeze({
    storeCardThumbnails: intEnv('FEED_STORE_CARD_THUMBNAILS', 3),
  }),
  cart: Object.freeze({
    maxQuantityPerItem: intEnv('CART_MAX_QUANTITY_PER_ITEM', 99),
  }),
  orders: Object.freeze({
    reservationTtlMs: intEnv('RESERVATION_TTL_MS', 15 * MINUTE_MS),
    mockPayEnabled:
      process.env.NODE_ENV === 'production' ? false : boolEnv('MOCK_PAY_ENABLED', true),
    shippingRates: Object.freeze({
      standard: intEnv('SHIPPING_RATE_STANDARD', 500),
      express: intEnv('SHIPPING_RATE_EXPRESS', 1500),
      pickup: intEnv('SHIPPING_RATE_PICKUP', 0),
    }),
    idempotencyTtlMs: intEnv('CHECKOUT_IDEMPOTENCY_TTL_MS', 10 * MINUTE_MS),
    lowStockThreshold: intEnv('LOW_STOCK_THRESHOLD', 5),
  }),
  faircoin: Object.freeze({
    explorerApiUrl: strEnv('FAIRCOIN_EXPLORER_API_URL', 'https://explorer.fairco.in'),
    rateCacheTtlMs: intEnv('FAIRCOIN_RATE_CACHE_TTL_MS', 5 * MINUTE_MS),
    requestTimeoutMs: intEnv('FAIRCOIN_RATE_REQUEST_TIMEOUT_MS', 5_000),
    usdToEurRate: floatEnv('FAIRCOIN_USD_TO_EUR_RATE', 0.92),
    fallbackUsdPerFair: floatEnv('FAIRCOIN_FALLBACK_USD_PER_FAIR', 0.49),
  }),
});

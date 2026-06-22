/**
 * Quote service — generate + list quotes for a shipment.
 *
 * `quoteShipment` computes the pickup→dropoff distance (Haversine), persists it
 * on the shipment, writes ONE internal Moovo-courier quote SYNCHRONOUSLY (from
 * `pricing.service`), then fans out to every enabled external `Provider` via the
 * adapter registry under `Promise.allSettled` — per-adapter isolation, so one
 * failing/slow provider NEVER blocks the others (each failure is logged, never
 * silently swallowed). Once at least the internal quote lands, the shipment flips
 * `quoting → quoted`. All prices are FAIR (the stored source of truth).
 */

import type { ProviderQuote } from '@moovo/shared-types';
import { Shipment, type IShipment } from '../models/shipment.js';
import { Quote, type IQuote, type IPriceBreakdown } from '../models/quote.js';
import { Provider, type IProvider } from '../models/provider.js';
import { computeInternalQuote } from './pricing.service.js';
import { getAdapter } from './providers/provider-registry.js';
import type { ProviderAdapter } from './providers/provider-adapter.js';
import { distanceMetersBetween } from '../utils/geo.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/** Build the persisted FAIR price breakdown from a `ProviderQuote`. */
function toPriceBreakdown(quote: ProviderQuote): IPriceBreakdown {
  const breakdown: IPriceBreakdown = {
    base: quote.priceBreakdown.base,
    distance: quote.priceBreakdown.distance,
    size: quote.priceBreakdown.size,
    total: quote.priceBreakdown.total,
  };
  if (quote.priceBreakdown.surge) {
    breakdown.surge = quote.priceBreakdown.surge;
  }
  if (quote.priceBreakdown.fees) {
    breakdown.fees = quote.priceBreakdown.fees;
  }
  return breakdown;
}

/** The shape passed to `Quote.create` for one quote. */
interface QuoteCreateDoc {
  shipmentId: string;
  source: IQuote['source'];
  providerId?: string;
  providerQuoteRef?: string;
  priceBreakdown: IPriceBreakdown;
  etaPickupMin?: number;
  etaDeliveryMin?: number;
  expiresAt: Date;
  status: 'active';
}

/** Run a provider adapter's `quote` under a hard timeout so a slow provider never blocks. */
async function quoteWithTimeout(
  adapter: ProviderAdapter,
  shipment: IShipment,
): Promise<ProviderQuote[]> {
  return Promise.race([
    adapter.quote(shipment),
    new Promise<ProviderQuote[]>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Provider ${adapter.key} quote timed out`)),
        config.quotes.providerTimeoutMs,
      );
      // Do not keep the event loop alive solely for this timer.
      timer.unref?.();
    }),
  ]);
}

/**
 * Fan out to every enabled provider that supports the shipment's type, collecting
 * the docs to persist. Per-adapter isolation via `Promise.allSettled`: a rejected
 * adapter is logged and skipped; the others still contribute quotes.
 */
async function collectProviderQuotes(
  shipment: IShipment,
  providers: IProvider[],
  expiresAt: Date,
): Promise<QuoteCreateDoc[]> {
  const results = await Promise.allSettled(
    providers.map(async (provider): Promise<QuoteCreateDoc[]> => {
      const adapter = getAdapter(provider.key);
      if (!adapter) {
        log.general.warn(
          { providerKey: provider.key },
          'Enabled provider has no registered adapter; skipping',
        );
        return [];
      }
      const quotes = await quoteWithTimeout(adapter, shipment);
      return quotes.map((q) => {
        const doc: QuoteCreateDoc = {
          shipmentId: String(shipment._id),
          source: 'external_provider',
          providerId: String(provider._id),
          priceBreakdown: toPriceBreakdown(q),
          expiresAt,
          status: 'active',
        };
        if (q.providerQuoteRef !== undefined) {
          doc.providerQuoteRef = q.providerQuoteRef;
        }
        if (q.etaPickupMin !== undefined) {
          doc.etaPickupMin = q.etaPickupMin;
        }
        if (q.etaDeliveryMin !== undefined) {
          doc.etaDeliveryMin = q.etaDeliveryMin;
        }
        return doc;
      });
    }),
  );

  const docs: QuoteCreateDoc[] = [];
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      docs.push(...result.value);
    } else {
      log.general.warn(
        { err: result.reason, providerKey: providers[idx]?.key },
        'Provider quote failed; isolated from other providers',
      );
    }
  });
  return docs;
}

/**
 * Generate quotes for a shipment. Computes + persists the distance, writes the
 * internal Moovo-courier quote synchronously, fans out to enabled providers, then
 * flips the shipment to `quoted`. Returns the persisted quotes (internal first).
 */
export async function quoteShipment(shipment: IShipment): Promise<IQuote[]> {
  const shipmentId = String(shipment._id);
  const distanceM = distanceMetersBetween(
    shipment.pickup.location.coordinates,
    shipment.dropoff.location.coordinates,
  );
  const expiresAt = new Date(Date.now() + config.quotes.ttlMs);

  // Persist the computed distance on the shipment up front.
  await Shipment.updateOne({ _id: shipment._id }, { $set: { distanceM } });

  // 1. Internal Moovo-courier quote — written synchronously (always present).
  const internalBreakdown = computeInternalQuote({
    distanceM,
    sizeClass: shipment.parcel.sizeClass,
    type: shipment.type,
  });
  const internalDoc: QuoteCreateDoc = {
    shipmentId,
    source: 'moovo_courier',
    priceBreakdown: internalBreakdown,
    expiresAt,
    status: 'active',
  };

  // 2. External-provider fan-out (per-adapter isolated).
  const providers = await Provider.find({
    enabled: true,
    supportedTypes: shipment.type,
  }).lean<IProvider[]>();
  const providerDocs = await collectProviderQuotes(shipment, providers, expiresAt);

  const created = await Quote.insertMany([internalDoc, ...providerDocs]);
  const quotes = created.map((q) => q.toObject<IQuote>());

  // 3. The internal quote always lands → flip quoting → quoted.
  await Shipment.updateOne(
    { _id: shipment._id, status: { $in: ['draft', 'quoting'] } },
    { $set: { status: 'quoted' } },
  );

  log.general.info(
    { shipmentId, distanceM, internal: 1, external: providerDocs.length },
    'Generated quotes for shipment',
  );

  return quotes;
}

/** List the active quotes for a shipment (newest-priced first by source then time). */
export async function listQuotes(shipmentId: string): Promise<IQuote[]> {
  return Quote.find({ shipmentId, status: { $in: ['active', 'selected'] } })
    .sort({ source: 1, createdAt: 1 })
    .lean<IQuote[]>();
}

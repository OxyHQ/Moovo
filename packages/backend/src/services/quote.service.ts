/**
 * Quote service — generate + list quotes for a shipment.
 *
 * `quoteShipment` computes the pickup→dropoff distance (Haversine), persists it
 * on the shipment, prices ONE internal Moovo-courier quote (from
 * `pricing.service`), then fans out to every enabled external provider via the
 * adapter registry under `Promise.allSettled` — per-adapter isolation, so one
 * failing/slow provider NEVER blocks the others (each failure is logged, never
 * silently swallowed). Once at least the internal quote lands, the shipment flips
 * `quoting → quoted`. All prices are FAIR (the stored source of truth).
 *
 * ## Where the transaction is, and where it deliberately is not
 *
 * The quote inserts and the `quoting → quoted` flip commit TOGETHER. They are
 * one fact — "this shipment has been quoted" — and the source could not express
 * that, because the two collections were separate Mongo writes; a crash between
 * them left a shipment stuck in `quoting` with its quotes already visible. Both
 * rows live in one database now, so the atomicity is nearly free.
 *
 * The transaction does NOT span the provider fan-out. Holding one open across
 * several carriers' network calls — each with its own timeout — would pin a
 * connection from a pool of ten for as long as the slowest adapter takes, which
 * is exactly the shape that turns one slow carrier into a service-wide
 * connection shortage. The distance write stays outside and BEFORE the fan-out,
 * as in the source, because it is persisted up front on purpose.
 */

import {
  listEnabledProvidersForType,
  type ProviderRow,
} from '../db/transport/providerRepository.js';
import type { ProviderQuote } from '@moovo/shared-types';
import { getDb } from '../db/postgres.js';
import type { ShipmentRecord } from '../db/transport/shipmentShape.js';
import {
  markShipmentQuoted,
  updateShipmentDistance,
} from '../db/transport/shipmentRepository.js';
import {
  insertQuotes,
  listActiveQuotesForShipment,
  type NewQuote,
  type QuoteRecord,
} from '../db/transport/quoteRepository.js';
import { computeInternalQuote } from './pricing.service.js';
import { getAdapter } from './providers/provider-registry.js';
import type { ProviderAdapter } from './providers/provider-adapter.js';
import { distanceMetersBetween } from '../utils/geo.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

/** Run a provider adapter's `quote` under a hard timeout so a slow provider never blocks. */
async function quoteWithTimeout(
  adapter: ProviderAdapter,
  shipment: ShipmentRecord,
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
 * the quotes to persist. Per-adapter isolation via `Promise.allSettled`: a rejected
 * adapter is logged and skipped; the others still contribute quotes.
 */
async function collectProviderQuotes(
  shipment: ShipmentRecord,
  providers: ProviderRow[],
  expiresAt: Date,
): Promise<NewQuote[]> {
  const results = await Promise.allSettled(
    providers.map(async (provider): Promise<NewQuote[]> => {
      const adapter = getAdapter(provider.key);
      if (!adapter) {
        log.general.warn(
          { providerKey: provider.key },
          'Enabled provider has no registered adapter; skipping',
        );
        return [];
      }
      const quotes = await quoteWithTimeout(adapter, shipment);
      return quotes.map((q) => ({
        shipmentId: shipment.id,
        source: 'external_provider',
        providerId: provider.id,
        providerQuoteRef: q.providerQuoteRef,
        priceBreakdown: q.priceBreakdown,
        etaPickupMin: q.etaPickupMin,
        etaDeliveryMin: q.etaDeliveryMin,
        expiresAt,
        status: 'active',
      }));
    }),
  );

  const docs: NewQuote[] = [];
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
 * Generate quotes for a shipment. Computes + persists the distance, prices the
 * internal Moovo-courier quote, fans out to enabled providers, then writes every
 * quote and flips the shipment to `quoted` in ONE transaction. Returns the
 * persisted quotes (internal first).
 */
export async function quoteShipment(shipment: ShipmentRecord): Promise<QuoteRecord[]> {
  const shipmentId = shipment.id;
  const distanceM = distanceMetersBetween(
    shipment.pickup.location.coordinates,
    shipment.dropoff.location.coordinates,
  );
  const expiresAt = new Date(Date.now() + config.quotes.ttlMs);

  // Persist the computed distance on the shipment up front — before the fan-out,
  // so it is visible for the duration of it.
  await updateShipmentDistance(shipmentId, distanceM);

  // 1. Internal Moovo-courier quote — always priced, always present.
  const internalDoc: NewQuote = {
    shipmentId,
    source: 'moovo_courier',
    priceBreakdown: computeInternalQuote({
      distanceM,
      sizeClass: shipment.parcel.sizeClass,
      type: shipment.type,
    }),
    expiresAt,
    status: 'active',
  };

  // 2. External-provider fan-out (per-adapter isolated), OUTSIDE the transaction.
  const providers = await listEnabledProvidersForType(shipment.type);
  const providerDocs = await collectProviderQuotes(shipment, providers, expiresAt);

  // 3. The quotes and the status flip are one fact, so they commit together.
  const quotes = await getDb().transaction(async (tx) => {
    const written = await insertQuotes([internalDoc, ...providerDocs], tx);
    await markShipmentQuoted(shipmentId, tx);
    return written;
  });

  log.general.info(
    { shipmentId, distanceM, internal: 1, external: providerDocs.length },
    'Generated quotes for shipment',
  );

  return quotes;
}

/** List the active quotes for a shipment (by source then time). */
export async function listQuotes(shipmentId: string): Promise<QuoteRecord[]> {
  return listActiveQuotesForShipment(shipmentId);
}

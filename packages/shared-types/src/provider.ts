/**
 * External-provider DTOs for the Moovo transport domain.
 *
 * A `Provider` is an external delivery carrier (e.g. DHL, FedEx) that can fulfil
 * shipments alongside Moovo's own couriers. The set of enabled providers is
 * data-driven: each provider doc declares which shipment types and countries it
 * supports plus opaque, NON-secret adapter `config`. Credentials/secrets are
 * NEVER stored inline — they come from the runtime environment / secret store.
 *
 * Quotes a provider returns are FAIR-priced (`ProviderQuote.priceBreakdown` is a
 * {@link PriceBreakdown}); the provider adapter is responsible for converting any
 * fiat carrier price into FAIR before returning it.
 */

import type { ShipmentType } from './shipment';
import type { PriceBreakdown } from './quote';

/** A registered external delivery provider. */
export interface Provider {
  /** Stable provider id. */
  id: string;
  /** Stable adapter key (matches the registered `ProviderAdapter.key`). */
  key: string;
  /** Human display name. */
  name: string;
  /** Oxy media file id of the provider logo, when present. */
  logoFileId?: string;
  /** Whether the provider is currently enabled for quoting. */
  enabled: boolean;
  /** Shipment types the provider can fulfil. */
  supportedTypes: ShipmentType[];
  /** ISO-3166 alpha-2 country codes the provider serves. */
  supportedCountries: string[];
  /** Opaque, NON-secret adapter configuration. */
  config?: Record<string, unknown>;
}

/** A compact, public projection of a provider for display. */
export interface ProviderSummary {
  /** Stable provider id. */
  id: string;
  /** Stable adapter key. */
  key: string;
  /** Human display name. */
  name: string;
  /** Provider logo URL, resolved through the media chokepoint, when present. */
  logoUrl?: string;
  /** Whether the provider is currently enabled. */
  enabled: boolean;
  /** Shipment types the provider can fulfil. */
  supportedTypes: ShipmentType[];
}

/**
 * A priced fulfilment option returned by a provider adapter's `quote`. The
 * `priceBreakdown` is FAIR (the adapter converts any fiat carrier price to FAIR).
 */
export interface ProviderQuote {
  /** The adapter key that produced the quote. */
  providerKey: string;
  /** Provider-side quote reference, when the carrier returns one. */
  providerQuoteRef?: string;
  /** FAIR-priced breakdown. */
  priceBreakdown: PriceBreakdown;
  /** Estimated minutes until pickup, when known. */
  etaPickupMin?: number;
  /** Estimated minutes until delivery, when known. */
  etaDeliveryMin?: number;
}

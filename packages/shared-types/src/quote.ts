/**
 * Quote DTOs for the Moovo transport domain.
 *
 * A `Quote` is one priced fulfilment option for a `Shipment`: either an internal
 * Moovo-courier quote (`source: 'moovo_courier'`, priced by the internal pricing
 * engine) or an external-provider quote (`source: 'external_provider'`, returned
 * by a provider adapter). Every price field is a FAIR {@link FairMoney} value —
 * FAIR is the stored source of truth. Output DTOs that show a converted display
 * amount use the {@link DisplayMoney} analog (`DisplayPriceBreakdown`); the
 * hydration layer performs the FAIR→fiat conversion at the API boundary.
 */

import type { FairMoney, DisplayMoney } from './fair-money';

/** Whether a quote comes from a Moovo courier or an external provider. */
export type QuoteSource = 'moovo_courier' | 'external_provider';

/** Lifecycle status of a quote. */
export type QuoteStatus = 'active' | 'selected' | 'expired';

/**
 * The FAIR-priced breakdown of a quote. Every component is a {@link FairMoney}
 * value in FAIR minor units; `total` is the sum of the present components.
 */
export interface PriceBreakdown {
  /** Flat base fare for the job. */
  base: FairMoney;
  /** Distance-proportional component. */
  distance: FairMoney;
  /** Size/weight surcharge component. */
  size: FairMoney;
  /** Demand surge component, when applied. */
  surge?: FairMoney;
  /** Platform/service fees, when applied. */
  fees?: FairMoney;
  /** Sum of all present components. */
  total: FairMoney;
}

/**
 * The {@link DisplayMoney} analog of {@link PriceBreakdown} for output DTOs:
 * each component carries both the stored FAIR amount and a converted display
 * amount. Produced by the hydration layer; storage always stays FAIR.
 */
export interface DisplayPriceBreakdown {
  /** Flat base fare for the job. */
  base: DisplayMoney;
  /** Distance-proportional component. */
  distance: DisplayMoney;
  /** Size/weight surcharge component. */
  size: DisplayMoney;
  /** Demand surge component, when applied. */
  surge?: DisplayMoney;
  /** Platform/service fees, when applied. */
  fees?: DisplayMoney;
  /** Sum of all present components. */
  total: DisplayMoney;
}

/** A priced fulfilment option for a shipment (FAIR is the source of truth). */
export interface Quote {
  /** Stable quote id. */
  id: string;
  /** The shipment this quote prices. */
  shipmentId: string;
  /** Whether the quote is internal (Moovo courier) or external (provider). */
  source: QuoteSource;
  /** Provider id (the `Provider._id`), for external-provider quotes. */
  providerId?: string;
  /** Provider-side quote reference, for external-provider quotes. */
  providerQuoteRef?: string;
  /** FAIR-priced breakdown (source of truth). */
  priceBreakdown: PriceBreakdown;
  /** Estimated minutes until pickup, when known. */
  etaPickupMin?: number;
  /** Estimated minutes until delivery, when known. */
  etaDeliveryMin?: number;
  /** ISO-8601 time after which the quote may no longer be booked. */
  expiresAt: string;
  /** Current lifecycle status. */
  status: QuoteStatus;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/**
 * The output projection of a quote with display-converted prices. Mirrors
 * {@link Quote} but the breakdown carries both FAIR and a converted display
 * amount.
 */
export interface QuoteView {
  /** Stable quote id. */
  id: string;
  /** The shipment this quote prices. */
  shipmentId: string;
  /** Whether the quote is internal (Moovo courier) or external (provider). */
  source: QuoteSource;
  /** Provider id, for external-provider quotes. */
  providerId?: string;
  /** Provider display name, hydrated for external-provider quotes. */
  providerName?: string;
  /** Provider logo URL, resolved through the media chokepoint, when present. */
  providerLogoUrl?: string;
  /** Provider-side quote reference, for external-provider quotes. */
  providerQuoteRef?: string;
  /** Price breakdown carrying both FAIR and a converted display amount. */
  priceBreakdown: DisplayPriceBreakdown;
  /** Estimated minutes until pickup, when known. */
  etaPickupMin?: number;
  /** Estimated minutes until delivery, when known. */
  etaDeliveryMin?: number;
  /** ISO-8601 time after which the quote may no longer be booked. */
  expiresAt: string;
  /** Current lifecycle status. */
  status: QuoteStatus;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** The list of quotes generated for a shipment. */
export interface QuoteList {
  /** The shipment the quotes belong to. */
  shipmentId: string;
  /** The quotes generated for the shipment (display-converted). */
  quotes: QuoteView[];
}

/**
 * External-provider adapter contract.
 *
 * Every external delivery carrier (DHL, FedEx, …) is integrated behind this ONE
 * interface so there is ZERO per-provider branching anywhere else in the
 * codebase — the quote/job services call `quote`/`book`/`track` through the
 * registry, never an `if (provider === 'dhl')`. An adapter prices in FAIR (its
 * `quote` returns FAIR `ProviderQuote`s); converting any fiat carrier price to
 * FAIR is the adapter's responsibility.
 */

import type { JobStatus, ProviderQuote, GeoPoint } from '@moovo/shared-types';
import type { IShipment } from '../../models/shipment.js';
import type { IQuote } from '../../models/quote.js';

/** What an adapter returns from a successful `book`. */
export interface ProviderBooking {
  /** Provider-side booking reference (stored on the job as `providerRef`). */
  bookingRef: string;
  /** Optional customer-facing tracking URL. */
  trackingUrl?: string;
}

/** What an adapter returns from `track`. */
export interface ProviderTracking {
  /** The provider status mapped onto the Moovo `JobStatus` vocabulary. */
  status: JobStatus;
  /** The raw provider status string, for diagnostics. */
  rawStatus?: string;
  /** Last known location, when the provider reports one. */
  location?: GeoPoint;
}

/** A pluggable external delivery provider. */
export interface ProviderAdapter {
  /** Stable adapter key (matches `Provider.key`). */
  key: string;
  /** Price a shipment; returns zero or more FAIR-priced quotes. */
  quote(shipment: IShipment): Promise<ProviderQuote[]>;
  /** Book a shipment against a selected quote; returns the booking reference. */
  book(shipment: IShipment, quote: IQuote): Promise<ProviderBooking>;
  /** Fetch the current tracking status for a booking. */
  track(bookingRef: string): Promise<ProviderTracking>;
  /** Cancel a booking, when the provider supports cancellation. */
  cancel?(bookingRef: string): Promise<void>;
}

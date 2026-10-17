/**
 * External-provider adapter contract.
 *
 * Every external delivery carrier (DHL, FedEx, …) is integrated behind this ONE
 * interface so there is ZERO per-provider branching anywhere else in the
 * codebase — the quote/job services call `quote`/`book` through the registry,
 * never an `if (provider === 'dhl')`.
 *
 * ## There is no `track` here, and that is deliberate
 *
 * There used to be, with a `ProviderTracking` return typed as a `JobStatus`. It
 * had ZERO call sites for the whole life of the codebase, and it could not have
 * been used as written: `JobStatus` is a dispatch-auction vocabulary with no
 * `out_for_delivery` and no `exception`, and its key is a booking MOOVO MADE
 * rather than a number somebody pasted.
 *
 * Reading a carrier now lives behind `services/tracking/tracking-adapter.ts`,
 * which is keyed on a tracking number and speaks `TrackingStatus`. A carrier
 * that is both bookable and trackable (DHL) implements one of each, linked by
 * `tracking_carriers.provider_id`. An adapter prices in FAIR (its
 * `quote` returns FAIR `ProviderQuote`s); converting any fiat carrier price to
 * FAIR is the adapter's responsibility.
 */

import type { ProviderQuote } from '@moovo/shared-types';
import type { ShipmentRecord } from '../../db/transport/shipmentShape.js';
import type { QuoteRecord } from '../../db/transport/quoteRepository.js';

/** What an adapter returns from a successful `book`. */
export interface ProviderBooking {
  /** Provider-side booking reference (stored on the job as `providerRef`). */
  bookingRef: string;
  /** Optional customer-facing tracking URL. */
  trackingUrl?: string;
}

/**
 * Thrown by `book` ONLY when the carrier answered that it created NO booking —
 * a refusal it documents as final (validation, unserviceable route, rejected
 * account). The booking claim is marked `failed` and the shipment can be booked
 * again under a new operation id.
 *
 * Every other throw — a timeout, a reset connection, a 5xx, an unparseable
 * reply — is AMBIGUOUS: the carrier may have booked. Those leave the claim
 * `unknown` until `findBooking` answers.
 */
export class ProviderBookingRejected extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderBookingRejected';
  }
}

/** A pluggable external delivery provider. */
export interface ProviderAdapter {
  /** Stable adapter key (matches `Provider.key`). */
  key: string;
  /** Price a shipment; returns zero or more FAIR-priced quotes. */
  quote(shipment: ShipmentRecord): Promise<ProviderQuote[]>;
  /**
   * Book a shipment against a selected quote; returns the booking reference.
   *
   * `operationId` is the carrier-side idempotency key: the carrier must create
   * at most one booking per operation id, and `findBooking` must find it by it.
   */
  book(
    shipment: ShipmentRecord,
    quote: QuoteRecord,
    context: { operationId: string },
  ): Promise<ProviderBooking>;
  /**
   * The booking the carrier holds under `operationId`, or `null` when it holds
   * none. Throws when the carrier cannot answer — which is NOT "none".
   *
   * This is how a booking whose reply was lost is reconciled: never by booking
   * again blind, which is how one parcel becomes two.
   */
  findBooking(operationId: string): Promise<ProviderBooking | null>;
  /** Cancel a booking, when the provider supports cancellation. */
  cancel?(bookingRef: string): Promise<void>;
}

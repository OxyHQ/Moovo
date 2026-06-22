/**
 * Mock external-provider adapters (`dhl-mock`, `fedex-mock`).
 *
 * Clearly-labelled simulated carriers used until real DHL/FedEx integrations
 * land. Each prices a shipment in FAIR off the great-circle distance + a flat
 * carrier-specific base, derives an ETA from the distance, and returns a single
 * simulated quote. `book`/`track`/`cancel` simulate provider responses. They
 * implement the SAME `ProviderAdapter` interface as any real carrier — the rest
 * of the codebase never special-cases them.
 */

import type { ProviderQuote, FairMoney, JobStatus, GeoPoint } from '@moovo/shared-types';
import type { IShipment } from '../../../models/shipment.js';
import type { IQuote } from '../../../models/quote.js';
import type {
  ProviderAdapter,
  ProviderBooking,
  ProviderTracking,
} from '../provider-adapter.js';
import { distanceMetersBetween } from '../../../utils/geo.js';
import { log } from '../../../lib/logger.js';

/** Metres per kilometre. */
const METERS_PER_KM = 1000;
/** Average courier speed assumed when deriving an ETA, kilometres per hour. */
const ASSUMED_SPEED_KMH = 30;
/** Minutes per hour. */
const MINUTES_PER_HOUR = 60;
/** Flat pickup lead time added to every ETA, minutes. */
const PICKUP_LEAD_MIN = 20;

/** Per-mock-carrier pricing parameters (FAIR minor units). */
interface MockCarrierParams {
  /** Stable adapter key. */
  key: string;
  /** Human display name. */
  name: string;
  /** Flat base fare, FAIR minor units. */
  baseFairMinor: number;
  /** Distance rate, FAIR minor units per kilometre. */
  perKmFairMinor: number;
}

/** Wrap a FAIR minor-unit integer in a `FairMoney` value. */
function fair(fairMinor: number): FairMoney {
  return { fairMinor, originalCurrency: 'FAIR' };
}

/** Great-circle pickup→dropoff distance for a shipment, metres. */
function shipmentDistanceM(shipment: IShipment): number {
  return distanceMetersBetween(
    shipment.pickup.location.coordinates,
    shipment.dropoff.location.coordinates,
  );
}

/** Derived delivery ETA (minutes) for a distance at the assumed average speed. */
function deliveryEtaMin(distanceM: number): number {
  const distanceKm = distanceM / METERS_PER_KM;
  const travelMin = (distanceKm / ASSUMED_SPEED_KMH) * MINUTES_PER_HOUR;
  return Math.max(1, Math.round(PICKUP_LEAD_MIN + travelMin));
}

/** Build a mock `ProviderAdapter` for a carrier's pricing parameters. */
function makeMockAdapter(params: MockCarrierParams): ProviderAdapter {
  return {
    key: params.key,

    async quote(shipment: IShipment): Promise<ProviderQuote[]> {
      const distanceM = shipmentDistanceM(shipment);
      const distanceKm = distanceM / METERS_PER_KM;
      const baseFairMinor = params.baseFairMinor;
      const distanceFairMinor = Math.round(params.perKmFairMinor * distanceKm);
      const totalFairMinor = baseFairMinor + distanceFairMinor;

      const quote: ProviderQuote = {
        providerKey: params.key,
        providerQuoteRef: `${params.key}-${Date.now()}`,
        priceBreakdown: {
          base: fair(baseFairMinor),
          distance: fair(distanceFairMinor),
          size: fair(0),
          total: fair(totalFairMinor),
        },
        etaPickupMin: PICKUP_LEAD_MIN,
        etaDeliveryMin: deliveryEtaMin(distanceM),
      };
      return [quote];
    },

    async book(shipment: IShipment, _quote: IQuote): Promise<ProviderBooking> {
      const bookingRef = `${params.key}-bk-${String(shipment._id)}-${Date.now()}`;
      log.general.info(
        { providerKey: params.key, shipmentId: String(shipment._id), bookingRef },
        'Mock provider booking created',
      );
      return { bookingRef, trackingUrl: `https://example.invalid/${params.key}/${bookingRef}` };
    },

    async track(bookingRef: string): Promise<ProviderTracking> {
      // Mock carriers always report the booking as accepted (no live carrier feed).
      const status: JobStatus = 'accepted';
      const location: GeoPoint | undefined = undefined;
      log.general.info({ providerKey: params.key, bookingRef, status }, 'Mock provider tracking');
      return location ? { status, rawStatus: 'ACCEPTED', location } : { status, rawStatus: 'ACCEPTED' };
    },

    async cancel(bookingRef: string): Promise<void> {
      log.general.info({ providerKey: params.key, bookingRef }, 'Mock provider booking cancelled');
    },
  };
}

/** The mock carriers shipped in Phase 2 (FAIR-priced, distance-derived ETAs). */
export const MOCK_CARRIERS: readonly MockCarrierParams[] = [
  { key: 'dhl-mock', name: 'DHL (mock)', baseFairMinor: 700, perKmFairMinor: 90 },
  { key: 'fedex-mock', name: 'FedEx (mock)', baseFairMinor: 800, perKmFairMinor: 80 },
];

/** Build all mock adapters (one per `MOCK_CARRIERS` entry). */
export function buildMockAdapters(): ProviderAdapter[] {
  return MOCK_CARRIERS.map(makeMockAdapter);
}

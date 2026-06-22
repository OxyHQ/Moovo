/**
 * Shipment hydration service.
 *
 * Turns raw `IShipment` / `IQuote` documents into client-ready `Shipment` /
 * `QuoteView` DTOs, doing all Oxy + DB lookups in BATCHES (no N+1): ONE
 * `getProfiles` for the sender identities, ONE `Provider.find` for quote provider
 * names/logos. Media (shipment photos, provider logos) is resolved through the
 * SINGLE sanctioned chokepoint (`resolveMedia`); FAIR money is projected to
 * {@link DisplayMoney} via a rate fetched ONCE per request (`getFairRate`).
 */

import mongoose from 'mongoose';
import type {
  Shipment as ShipmentDTO,
  ShipmentPhoto,
  ShipmentEndpoint,
  ParcelDetails,
  Scheduling,
  QuoteView,
  QuoteList,
  FiatCurrency,
} from '@moovo/shared-types';
import type {
  IShipment,
  IShipmentEndpoint,
  IParcelDetails,
  IScheduling,
} from '../models/shipment.js';
import { type IQuote } from '../models/quote.js';
import { Provider, type IProvider } from '../models/provider.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { getFairRate } from './faircoin-rate.service.js';
import { toDisplayPriceBreakdown } from '../utils/fair-display.js';

/** Map a persisted endpoint to the `ShipmentEndpoint` DTO (omit absent optionals). */
function toEndpoint(endpoint: IShipmentEndpoint): ShipmentEndpoint {
  const dto: ShipmentEndpoint = {
    location: {
      type: 'Point',
      coordinates: [endpoint.location.coordinates[0], endpoint.location.coordinates[1]],
    },
    address: {
      line1: endpoint.address.line1,
      city: endpoint.address.city,
      postalCode: endpoint.address.postalCode,
      country: endpoint.address.country,
    },
    contactName: endpoint.contactName,
    contactPhone: endpoint.contactPhone,
  };
  if (endpoint.address.line2) dto.address.line2 = endpoint.address.line2;
  if (endpoint.address.region) dto.address.region = endpoint.address.region;
  if (endpoint.notes) dto.notes = endpoint.notes;
  return dto;
}

/** Map persisted parcel details to the `ParcelDetails` DTO (omit absent optionals). */
function toParcel(parcel: IParcelDetails): ParcelDetails {
  const dto: ParcelDetails = {
    weightKg: parcel.weightKg,
    sizeClass: parcel.sizeClass,
    pieces: parcel.pieces,
  };
  if (parcel.dimsCm) dto.dimsCm = { l: parcel.dimsCm.l, w: parcel.dimsCm.w, h: parcel.dimsCm.h };
  if (parcel.fragile !== undefined) dto.fragile = parcel.fragile;
  return dto;
}

/** Map persisted scheduling to the `Scheduling` DTO. */
function toScheduling(scheduling: IScheduling): Scheduling {
  if (scheduling.kind === 'scheduled' && scheduling.scheduledFor) {
    return { kind: 'scheduled', scheduledFor: scheduling.scheduledFor.toISOString() };
  }
  return { kind: 'now' };
}

/** Map shipment photos through the media chokepoint into `ShipmentPhoto` DTOs. */
function toPhotos(photos: IShipment['photos']): ShipmentPhoto[] {
  return [...photos]
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const dto: ShipmentPhoto = { fileId: resolveMedia(p.fileId), position: p.position };
      if (p.alt) dto.alt = p.alt;
      return dto;
    });
}

/** Build a `Shipment` DTO from a raw doc. */
function toShipmentDTO(shipment: IShipment): ShipmentDTO {
  const dto: ShipmentDTO = {
    id: String((shipment as { _id: mongoose.Types.ObjectId })._id),
    senderOxyUserId: String(shipment.senderOxyUserId),
    type: shipment.type,
    status: shipment.status,
    pickup: toEndpoint(shipment.pickup),
    dropoff: toEndpoint(shipment.dropoff),
    parcel: toParcel(shipment.parcel),
    itemDescription: shipment.itemDescription,
    photos: toPhotos(shipment.photos),
    scheduling: toScheduling(shipment.scheduling),
    createdAt: shipment.createdAt.toISOString(),
    updatedAt: shipment.updatedAt.toISOString(),
  };
  if (shipment.distanceM !== undefined) dto.distanceM = shipment.distanceM;
  if (shipment.quoteRef) dto.quoteRef = shipment.quoteRef;
  if (shipment.jobId) dto.jobId = shipment.jobId;
  return dto;
}

/**
 * Hydrate raw shipment docs into client-ready `Shipment` DTOs. Identity is read
 * live from Oxy at the route layer where needed; the shipment DTO itself carries
 * only the sender's Oxy user id. Preserves input order.
 */
export async function hydrateShipments(shipments: IShipment[]): Promise<ShipmentDTO[]> {
  if (shipments.length === 0) {
    return [];
  }
  return shipments.map(toShipmentDTO);
}

/** Summarize raw shipment docs (the same DTO shape is compact enough for lists). */
export async function summarizeShipments(shipments: IShipment[]): Promise<ShipmentDTO[]> {
  return hydrateShipments(shipments);
}

/**
 * Hydrate the quotes for a shipment into a `QuoteList` with display-converted
 * prices and provider names/logos. ONE `getFairRate` + ONE `Provider.find`.
 */
export async function hydrateQuotes(
  shipmentId: string,
  quotes: IQuote[],
  displayCurrency: FiatCurrency,
): Promise<QuoteList> {
  if (quotes.length === 0) {
    return { shipmentId, quotes: [] };
  }

  const providerIds = [
    ...new Set(quotes.filter((q) => q.providerId).map((q) => String(q.providerId))),
  ];
  const [rate, providerDocs] = await Promise.all([
    getFairRate(displayCurrency),
    providerIds.length > 0
      ? Provider.find({ _id: { $in: providerIds } }).lean<IProvider[]>()
      : Promise.resolve([] as IProvider[]),
  ]);
  const providerById = new Map<string, IProvider>();
  for (const p of providerDocs) {
    providerById.set(String((p as { _id: mongoose.Types.ObjectId })._id), p);
  }

  const views: QuoteView[] = quotes.map((quote) => {
    const view: QuoteView = {
      id: String((quote as { _id: mongoose.Types.ObjectId })._id),
      shipmentId: String(quote.shipmentId),
      source: quote.source,
      priceBreakdown: toDisplayPriceBreakdown(quote.priceBreakdown, rate),
      expiresAt: quote.expiresAt.toISOString(),
      status: quote.status,
      createdAt: quote.createdAt.toISOString(),
    };
    if (quote.providerId) {
      view.providerId = String(quote.providerId);
      const provider = providerById.get(String(quote.providerId));
      if (provider) {
        view.providerName = provider.name;
        if (provider.logoFileId) {
          view.providerLogoUrl = resolveMedia(provider.logoFileId);
        }
      }
    }
    if (quote.providerQuoteRef) view.providerQuoteRef = quote.providerQuoteRef;
    if (quote.etaPickupMin !== undefined) view.etaPickupMin = quote.etaPickupMin;
    if (quote.etaDeliveryMin !== undefined) view.etaDeliveryMin = quote.etaDeliveryMin;
    return view;
  });

  return { shipmentId, quotes: views };
}

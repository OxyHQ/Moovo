/**
 * Shipment DTOs for the Moovo transport domain.
 *
 * A `Shipment` is a customer's request to move something from a pickup endpoint
 * to a dropoff endpoint — the entry point of the request → quotes → booking →
 * job lifecycle. It carries the parcel/cargo details and scheduling, but NO
 * price: pricing lives on the `Quote`s generated for it (internal Moovo-courier
 * pricing + external-provider quotes). Once a quote is selected and booked, the
 * shipment references the resulting `Job` (`jobId`) and selected `Quote`
 * (`quoteRef`).
 *
 * `GeoPoint`, `DimensionsCm` and `SizeClass` are reused from the courier domain
 * (`./courier`) — they are NOT redeclared here.
 */

import type { Timestamps } from './common';
import type { GeoPoint, DimensionsCm, SizeClass } from './courier';

/** The kind of thing being moved — mirrors the courier `JobType`. */
export type ShipmentType = 'package' | 'food' | 'move';

/**
 * Lifecycle status of a shipment.
 *
 * `draft` (not yet quoted) → `quoting` (quotes being generated) → `quoted`
 * (quotes available for selection) → `booked` (a quote was selected and a job
 * created); `cancelled` and `expired` are terminal exits.
 */
export type ShipmentStatus = 'draft' | 'quoting' | 'quoted' | 'booked' | 'cancelled' | 'expired';

/** A postal address attached to a shipment endpoint. */
export interface ShipmentAddress {
  /** Street address line 1. */
  line1: string;
  /** Street address line 2 (apt/suite), when present. */
  line2?: string;
  /** City / locality. */
  city: string;
  /** State / region / province, when present. */
  region?: string;
  /** Postal / ZIP code. */
  postalCode: string;
  /** ISO-3166 alpha-2 country code. */
  country: string;
}

/** One end (pickup or dropoff) of a shipment: location + address + contact. */
export interface ShipmentEndpoint {
  /** GeoJSON point (`[lng, lat]`) used for distance + dispatch geo-queries. */
  location: GeoPoint;
  /** The postal address at this endpoint. */
  address: ShipmentAddress;
  /** Name of the person to hand off to / collect from at this endpoint. */
  contactName: string;
  /** Contact phone at this endpoint. */
  contactPhone: string;
  /** Free-text notes for the courier (e.g. "ring the buzzer twice"). */
  notes?: string;
}

/** Physical parcel/cargo details of a shipment. */
export interface ParcelDetails {
  /** Total weight of the shipment, kilograms. */
  weightKg: number;
  /** Bounding dimensions of the largest piece, centimetres, when known. */
  dimsCm?: DimensionsCm;
  /** Coarse size class used by the capability/eligibility engine. */
  sizeClass: SizeClass;
  /** Number of distinct pieces in the shipment. */
  pieces: number;
  /** Whether the contents are fragile and need careful handling. */
  fragile?: boolean;
}

/**
 * When the shipment should be fulfilled: immediately (`now`) or at a future
 * `scheduledFor` time (`scheduled`).
 */
export type Scheduling =
  | { kind: 'now' }
  | { kind: 'scheduled'; scheduledFor: string };

/** A shipment photo (an Oxy media file id + optional alt text + ordering). */
export interface ShipmentPhoto {
  /** Oxy media file id (resolved via the media chokepoint on output). */
  fileId: string;
  /** Optional descriptive alt text. */
  alt?: string;
  /** Display ordering of the photo. */
  position: number;
}

/**
 * A customer's shipment request. Holds endpoints, parcel details and scheduling;
 * price always lives on the generated `Quote`s, never on the shipment itself.
 */
export interface Shipment extends Timestamps {
  /** Stable shipment id. */
  id: string;
  /** Oxy user id of the customer who created the shipment. */
  senderOxyUserId: string;
  /** What is being moved. */
  type: ShipmentType;
  /** Current lifecycle status. */
  status: ShipmentStatus;
  /** Where the shipment is collected from. */
  pickup: ShipmentEndpoint;
  /** Where the shipment is delivered to. */
  dropoff: ShipmentEndpoint;
  /** Parcel/cargo details. */
  parcel: ParcelDetails;
  /** Human description of the shipment contents. */
  itemDescription: string;
  /** Reference photos of the shipment (Oxy media file ids resolved on output). */
  photos: ShipmentPhoto[];
  /** When the shipment should be fulfilled. */
  scheduling: Scheduling;
  /** Great-circle pickup→dropoff distance in metres, computed at quoting. */
  distanceM?: number;
  /** Id of the selected `Quote`, once booked. */
  quoteRef?: string;
  /** Id of the created `Job`, once booked. */
  jobId?: string;
}

/** Body for `POST /shipments` — create a shipment (no price; quoting follows). */
export interface CreateShipmentInput {
  /** What is being moved. */
  type: ShipmentType;
  /** Where the shipment is collected from. */
  pickup: ShipmentEndpoint;
  /** Where the shipment is delivered to. */
  dropoff: ShipmentEndpoint;
  /** Parcel/cargo details. */
  parcel: ParcelDetails;
  /** Human description of the shipment contents. */
  itemDescription: string;
  /** Reference photos (Oxy media file ids). */
  photos?: ShipmentPhoto[];
  /** When the shipment should be fulfilled (defaults to `now`). */
  scheduling?: Scheduling;
}

/** Query parameters for listing a customer's shipments. */
export interface ShipmentQuery {
  /** 1-based page index. */
  page?: number;
  /** Page size. */
  limit?: number;
  /** Optional status filter. */
  status?: ShipmentStatus;
  /** Optional type filter. */
  type?: ShipmentType;
}

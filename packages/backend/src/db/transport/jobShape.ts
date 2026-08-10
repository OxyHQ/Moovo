/**
 * A job as its consumers read it, and the mapping to the columns that store it.
 *
 * The same division as `shipmentShape.ts`: this module owns the SHAPE and
 * `jobRepository.ts` owns the SQL. Nothing outside the two knows that `pickup`
 * is eleven columns or that a status event is a row in another table.
 *
 * ## Two record types, because the child tables are not free
 *
 * A job's audit trail and its breadcrumb trail live in `job_status_events` and
 * `job_location_pings`. The DETAIL view reads both; the LIST view
 * (`summarizeJobs`) reads neither, and loading them for a page of jobs is a
 * second query bought for nothing.
 *
 * So the two are different TYPES rather than one type with sometimes-empty
 * arrays. {@link JobRecord} has no children; {@link JobWithHistory} has them.
 * `hydrateJobs` takes the second, so handing it a list result is a `tsc` error
 * rather than a job rendering with an audit trail that silently says nothing
 * ever happened to it — which is exactly what a shared type with `[]` defaults
 * would produce, and is indistinguishable from a real job nobody touched.
 *
 * ## What the source called a snapshot, and what actually is one
 *
 * `pickupSnapshot`, `dropoffSnapshot` and `parcelSnapshot` keep their names
 * because they are still frozen copies taken at booking — but they are stored
 * as COLUMNS, not jsonb. Only `quoteSnapshot` and `totals` are jsonb, and they
 * earn it: a `PriceBreakdown` is read as a unit and never compared across rows.
 */

import type {
  FulfillmentType,
  JobStatus,
  PriceBreakdown,
  ShipmentType,
} from '@moovo/shared-types';
import type { jobs, jobLocationPings, jobStatusEvents } from '../schema/transport';
import type {
  ParcelDetailsValue,
  ShipmentEndpointValue,
  ShipmentGeoPointValue,
} from './shipmentShape';

/** A `jobs` row exactly as stored — flat, 50-odd columns. */
export type JobRow = typeof jobs.$inferSelect;
/** A `job_status_events` row exactly as stored. */
export type JobStatusEventRow = typeof jobStatusEvents.$inferSelect;
/** A `job_location_pings` row exactly as stored. */
export type JobLocationPingRow = typeof jobLocationPings.$inferSelect;

/** One entry in a job's audit trail. */
export interface JobStatusEventValue {
  status: JobStatus;
  at: Date;
  byOxyUserId?: string;
  note?: string;
  location?: ShipmentGeoPointValue;
}

/** One courier breadcrumb. */
export interface JobLocationPingValue {
  location: ShipmentGeoPointValue;
  at: Date;
}

/** What the courier captured at the doorstep. */
export interface JobProofOfDeliveryValue {
  photoFileId?: string;
  signatureFileId?: string;
  note?: string;
  recipientName?: string;
  at: Date;
}

/** How the job is being paid for. */
export interface JobPaymentValue {
  status: 'unpaid' | 'authorized' | 'paid' | 'refunded' | 'failed';
  provider: 'oxy_pay';
  reference?: string;
  paidAt?: Date;
}

/**
 * A persisted job WITHOUT its two child trails.
 *
 * `id` rather than `_id`: a uuid v7 string the application mints, and nothing
 * downstream wants an ObjectId.
 */
export interface JobRecord {
  id: string;
  jobNumber: string;
  shipmentId: string;
  senderOxyUserId: string;
  type: ShipmentType;
  fulfillmentType: FulfillmentType;
  courierOxyUserId?: string;
  companyId?: string;
  providerRef?: string;
  pickupSnapshot: ShipmentEndpointValue;
  dropoffSnapshot: ShipmentEndpointValue;
  parcelSnapshot: ParcelDetailsValue;
  quoteSnapshot: PriceBreakdown;
  totals: PriceBreakdown;
  status: JobStatus;
  proofOfDelivery?: JobProofOfDeliveryValue;
  payment: JobPaymentValue;
  dispatchAttempts: number;
  pickupCodeHash?: string;
  dropoffCodeHash?: string;
  pickupCode?: string;
  dropoffCode?: string;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A job WITH both trails — what a detail view and every action response need. */
export interface JobWithHistory extends JobRecord {
  statusHistory: JobStatusEventValue[];
  locationPings: JobLocationPingValue[];
}

/**
 * What booking supplies.
 *
 * No id, no status, no dispatch counter and no trails: none of those is the
 * caller's to provide. `status` is the table's `'requested'` default and the
 * first status event is written by the same transaction that writes the row.
 */
export interface NewJob {
  jobNumber: string;
  shipmentId: string;
  senderOxyUserId: string;
  type: ShipmentType;
  fulfillmentType: FulfillmentType;
  providerRef?: string | undefined;
  pickupSnapshot: ShipmentEndpointValue;
  dropoffSnapshot: ShipmentEndpointValue;
  parcelSnapshot: ParcelDetailsValue;
  quoteSnapshot: PriceBreakdown;
  totals: PriceBreakdown;
  pickupCode?: string | undefined;
  pickupCodeHash?: string | undefined;
  dropoffCode?: string | undefined;
  dropoffCodeHash?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** What appending one status event needs. */
export interface NewJobStatusEvent {
  jobId: string;
  status: JobStatus;
  at: Date;
  byOxyUserId?: string | undefined;
  note?: string | undefined;
  location?: ShipmentGeoPointValue | undefined;
}

/** The insertable half of a `jobs` row. */
type JobInsert = typeof jobs.$inferInsert;

/** GeoJSON's ordering, asserted here and nowhere else. See `shipmentShape.ts`. */
function toPoint(longitude: number, latitude: number): ShipmentGeoPointValue {
  return { type: 'Point', coordinates: [longitude, latitude] };
}

/** Flatten one endpoint into the eleven columns that store it. */
function endpointColumns(
  endpoint: ShipmentEndpointValue,
): {
  latitude: number;
  longitude: number;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  contactName: string;
  contactPhone: string;
  notes: string | null;
} {
  return {
    latitude: endpoint.location.coordinates[1],
    longitude: endpoint.location.coordinates[0],
    line1: endpoint.address.line1,
    line2: endpoint.address.line2 ?? null,
    city: endpoint.address.city,
    region: endpoint.address.region ?? null,
    postalCode: endpoint.address.postalCode,
    country: endpoint.address.country,
    contactName: endpoint.contactName,
    contactPhone: endpoint.contactPhone,
    notes: endpoint.notes ?? null,
  };
}

/** Rebuild one endpoint from its columns. */
function toEndpoint(parts: {
  latitude: number;
  longitude: number;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  contactName: string;
  contactPhone: string;
  notes: string | null;
}): ShipmentEndpointValue {
  return {
    location: toPoint(parts.longitude, parts.latitude),
    address: {
      line1: parts.line1,
      ...(parts.line2 === null ? {} : { line2: parts.line2 }),
      city: parts.city,
      ...(parts.region === null ? {} : { region: parts.region }),
      postalCode: parts.postalCode,
      country: parts.country,
    },
    contactName: parts.contactName,
    contactPhone: parts.contactPhone,
    ...(parts.notes === null ? {} : { notes: parts.notes }),
  };
}

/** The columns a create writes. The id is the repository's to mint. */
export function toJobColumns(input: NewJob): Omit<JobInsert, 'id'> {
  const pickup = endpointColumns(input.pickupSnapshot);
  const dropoff = endpointColumns(input.dropoffSnapshot);
  const parcel = input.parcelSnapshot;
  return {
    jobNumber: input.jobNumber,
    shipmentId: input.shipmentId,
    senderOxyUserId: input.senderOxyUserId,
    type: input.type,
    fulfillmentType: input.fulfillmentType,
    providerRef: input.providerRef ?? null,

    pickupLatitude: pickup.latitude,
    pickupLongitude: pickup.longitude,
    pickupLine1: pickup.line1,
    pickupLine2: pickup.line2,
    pickupCity: pickup.city,
    pickupRegion: pickup.region,
    pickupPostalCode: pickup.postalCode,
    pickupCountry: pickup.country,
    pickupContactName: pickup.contactName,
    pickupContactPhone: pickup.contactPhone,
    pickupNotes: pickup.notes,

    dropoffLatitude: dropoff.latitude,
    dropoffLongitude: dropoff.longitude,
    dropoffLine1: dropoff.line1,
    dropoffLine2: dropoff.line2,
    dropoffCity: dropoff.city,
    dropoffRegion: dropoff.region,
    dropoffPostalCode: dropoff.postalCode,
    dropoffCountry: dropoff.country,
    dropoffContactName: dropoff.contactName,
    dropoffContactPhone: dropoff.contactPhone,
    dropoffNotes: dropoff.notes,

    parcelWeightKg: parcel.weightKg,
    parcelDimsL: parcel.dimsCm?.l ?? null,
    parcelDimsW: parcel.dimsCm?.w ?? null,
    parcelDimsH: parcel.dimsCm?.h ?? null,
    parcelSizeClass: parcel.sizeClass,
    parcelPieces: parcel.pieces,
    ...(parcel.fragile === undefined ? {} : { parcelFragile: parcel.fragile }),

    quoteSnapshot: input.quoteSnapshot,
    totals: input.totals,

    pickupCode: input.pickupCode ?? null,
    pickupCodeHash: input.pickupCodeHash ?? null,
    dropoffCode: input.dropoffCode ?? null,
    dropoffCodeHash: input.dropoffCodeHash ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

/**
 * A row, as a record.
 *
 * Total: every row produces a record. `quoteSnapshot`/`totals` come back from
 * jsonb as `unknown` and are asserted to their declared content type — the
 * column is written only by {@link toJobColumns}, which takes a
 * `PriceBreakdown`, so the shape is the schema's own declaration rather than a
 * hope about what is in the column.
 */
export function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    jobNumber: row.jobNumber,
    shipmentId: row.shipmentId,
    senderOxyUserId: row.senderOxyUserId,
    type: row.type as ShipmentType,
    fulfillmentType: row.fulfillmentType as FulfillmentType,
    ...(row.courierOxyUserId === null ? {} : { courierOxyUserId: row.courierOxyUserId }),
    ...(row.companyId === null ? {} : { companyId: row.companyId }),
    ...(row.providerRef === null ? {} : { providerRef: row.providerRef }),
    pickupSnapshot: toEndpoint({
      latitude: row.pickupLatitude,
      longitude: row.pickupLongitude,
      line1: row.pickupLine1,
      line2: row.pickupLine2,
      city: row.pickupCity,
      region: row.pickupRegion,
      postalCode: row.pickupPostalCode,
      country: row.pickupCountry,
      contactName: row.pickupContactName,
      contactPhone: row.pickupContactPhone,
      notes: row.pickupNotes,
    }),
    dropoffSnapshot: toEndpoint({
      latitude: row.dropoffLatitude,
      longitude: row.dropoffLongitude,
      line1: row.dropoffLine1,
      line2: row.dropoffLine2,
      city: row.dropoffCity,
      region: row.dropoffRegion,
      postalCode: row.dropoffPostalCode,
      country: row.dropoffCountry,
      contactName: row.dropoffContactName,
      contactPhone: row.dropoffContactPhone,
      notes: row.dropoffNotes,
    }),
    parcelSnapshot: {
      weightKg: row.parcelWeightKg,
      ...(row.parcelDimsL === null || row.parcelDimsW === null || row.parcelDimsH === null
        ? {}
        : { dimsCm: { l: row.parcelDimsL, w: row.parcelDimsW, h: row.parcelDimsH } }),
      sizeClass: row.parcelSizeClass as ParcelDetailsValue['sizeClass'],
      pieces: row.parcelPieces,
      fragile: row.parcelFragile,
    },
    quoteSnapshot: row.quoteSnapshot as PriceBreakdown,
    totals: row.totals as PriceBreakdown,
    status: row.status as JobStatus,
    ...(row.podAt === null
      ? {}
      : {
          proofOfDelivery: {
            ...(row.podPhotoFileId === null ? {} : { photoFileId: row.podPhotoFileId }),
            ...(row.podSignatureFileId === null
              ? {}
              : { signatureFileId: row.podSignatureFileId }),
            ...(row.podNote === null ? {} : { note: row.podNote }),
            ...(row.podRecipientName === null
              ? {}
              : { recipientName: row.podRecipientName }),
            at: row.podAt,
          },
        }),
    payment: {
      status: row.paymentStatus as JobPaymentValue['status'],
      provider: row.paymentProvider as JobPaymentValue['provider'],
      ...(row.paymentReference === null ? {} : { reference: row.paymentReference }),
      ...(row.paidAt === null ? {} : { paidAt: row.paidAt }),
    },
    dispatchAttempts: row.dispatchAttempts,
    ...(row.pickupCodeHash === null ? {} : { pickupCodeHash: row.pickupCodeHash }),
    ...(row.dropoffCodeHash === null ? {} : { dropoffCodeHash: row.dropoffCodeHash }),
    ...(row.pickupCode === null ? {} : { pickupCode: row.pickupCode }),
    ...(row.dropoffCode === null ? {} : { dropoffCode: row.dropoffCode }),
    ...(row.idempotencyKey === null ? {} : { idempotencyKey: row.idempotencyKey }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One audit-trail row, as a value. */
export function toStatusEventValue(row: JobStatusEventRow): JobStatusEventValue {
  return {
    status: row.status as JobStatus,
    at: row.at,
    ...(row.byOxyUserId === null ? {} : { byOxyUserId: row.byOxyUserId }),
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.latitude === null || row.longitude === null
      ? {}
      : { location: toPoint(row.longitude, row.latitude) }),
  };
}

/** One breadcrumb row, as a value. */
export function toLocationPingValue(row: JobLocationPingRow): JobLocationPingValue {
  return { location: toPoint(row.longitude, row.latitude), at: row.at };
}

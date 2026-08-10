/**
 * Job hydration service.
 *
 * Turns persisted job records into client-ready `JobView` / `JobSummary` DTOs,
 * doing all lookups in BATCHES (no N+1): ONE `getFairRate` for the display
 * conversion, ONE `getProfiles` for sender + courier identities. Snapshots
 * (pickup/dropoff/parcel) are mapped VERBATIM (frozen at booking); FAIR money is
 * projected to {@link DisplayMoney} at a rate fetched ONCE per request; proof-of-
 * delivery media is resolved through the SINGLE chokepoint (`resolveMedia`).
 *
 * The two entry points take DIFFERENT types, and that is the whole guarantee:
 * `hydrateJobs` renders the audit and breadcrumb trails, so it takes a
 * `JobWithHistory`; `summarizeJobs` reads neither, so it takes a bare
 * `JobRecord`. Handing a list result — which does not load the trails, because
 * a page of jobs would be a second query for nothing — to `hydrateJobs` is a
 * `tsc` error rather than a job rendering as though nothing ever happened to it.
 *
 * The plaintext QR pickup/dropoff codes are surfaced ONLY when the caller passes
 * `includeCodes` (the viewer is the OWNER/sender). The courier and every other
 * viewer get the job WITHOUT the plaintext — they prove pickup/delivery by
 * scanning, which validates against the stored hash, never the plaintext.
 */

import type {
  JobView,
  JobSummary,
  JobStatusEvent,
  LocationPing,
  ProofOfDelivery,
  JobPaymentInfo,
  JobEndpointSnapshot,
  JobParcelSnapshot,
  FiatCurrency,
} from '@moovo/shared-types';
import type {
  JobLocationPingValue,
  JobPaymentValue,
  JobProofOfDeliveryValue,
  JobRecord,
  JobStatusEventValue,
  JobWithHistory,
} from '../db/transport/jobShape.js';
import type {
  ShipmentEndpointValue,
  ParcelDetailsValue,
} from '../db/transport/shipmentShape.js';
import { getFairRate } from './faircoin-rate.service.js';
import { resolveMedia } from './catalog-hydration.service.js';
import { toDisplayPriceBreakdown } from '../utils/fair-display.js';

/** Map a persisted endpoint snapshot to the DTO (verbatim — frozen at booking). */
function toEndpointSnapshot(endpoint: ShipmentEndpointValue): JobEndpointSnapshot {
  const dto: JobEndpointSnapshot = {
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

/** Map a persisted parcel snapshot to the DTO. */
function toParcelSnapshot(parcel: ParcelDetailsValue): JobParcelSnapshot {
  const dto: JobParcelSnapshot = {
    weightKg: parcel.weightKg,
    sizeClass: parcel.sizeClass,
    pieces: parcel.pieces,
  };
  if (parcel.dimsCm) dto.dimsCm = { l: parcel.dimsCm.l, w: parcel.dimsCm.w, h: parcel.dimsCm.h };
  if (parcel.fragile !== undefined) dto.fragile = parcel.fragile;
  return dto;
}

/** Map a persisted status event to the DTO. */
function toStatusEvent(event: JobStatusEventValue): JobStatusEvent {
  const dto: JobStatusEvent = { status: event.status, at: event.at.toISOString() };
  if (event.byOxyUserId) dto.byOxyUserId = event.byOxyUserId;
  if (event.note) dto.note = event.note;
  if (event.location) {
    dto.location = {
      type: 'Point',
      coordinates: [event.location.coordinates[0], event.location.coordinates[1]],
    };
  }
  return dto;
}

/** Map a persisted location ping to the DTO. */
function toLocationPing(ping: JobLocationPingValue): LocationPing {
  return {
    location: {
      type: 'Point',
      coordinates: [ping.location.coordinates[0], ping.location.coordinates[1]],
    },
    at: ping.at.toISOString(),
  };
}

/** Map a persisted proof-of-delivery to the DTO (media through the chokepoint). */
function toProofOfDelivery(proof: JobProofOfDeliveryValue): ProofOfDelivery {
  const dto: ProofOfDelivery = { at: proof.at.toISOString() };
  if (proof.photoFileId) dto.photoFileId = resolveMedia(proof.photoFileId);
  if (proof.signatureFileId) dto.signatureFileId = resolveMedia(proof.signatureFileId);
  if (proof.note) dto.note = proof.note;
  if (proof.recipientName) dto.recipientName = proof.recipientName;
  return dto;
}

/** Map a persisted payment sub-doc to the DTO. */
function toPaymentInfo(payment: JobPaymentValue): JobPaymentInfo {
  const dto: JobPaymentInfo = { status: payment.status, provider: payment.provider };
  if (payment.reference) dto.reference = payment.reference;
  if (payment.paidAt) dto.paidAt = payment.paidAt.toISOString();
  return dto;
}

/** Options controlling what a job hydration exposes. */
export interface HydrateJobOptions {
  /**
   * Surface the plaintext QR pickup/dropoff codes — set ONLY when the viewer is
   * the OWNER (sender). Couriers and all other viewers MUST omit/leave this false.
   */
  includeCodes?: boolean;
}

/**
 * Hydrate raw job docs into client-ready `JobView` DTOs with display-converted
 * prices. Preserves input order. The FAIR rate is fetched once for the batch.
 * Plaintext QR codes are surfaced only when `opts.includeCodes` (owner-scoped).
 */
export async function hydrateJobs(
  jobs: JobWithHistory[],
  displayCurrency: FiatCurrency,
  opts: HydrateJobOptions = {},
): Promise<JobView[]> {
  if (jobs.length === 0) {
    return [];
  }
  const rate = await getFairRate(displayCurrency);

  return jobs.map((job) => {
    const view: JobView = {
      id: job.id,
      jobNumber: job.jobNumber,
      shipmentId: job.shipmentId,
      senderOxyUserId: job.senderOxyUserId,
      type: job.type,
      fulfillmentType: job.fulfillmentType,
      pickupSnapshot: toEndpointSnapshot(job.pickupSnapshot),
      dropoffSnapshot: toEndpointSnapshot(job.dropoffSnapshot),
      parcelSnapshot: toParcelSnapshot(job.parcelSnapshot),
      quoteSnapshot: toDisplayPriceBreakdown(job.quoteSnapshot, rate),
      status: job.status,
      statusHistory: job.statusHistory.map(toStatusEvent),
      locationPings: job.locationPings.map(toLocationPing),
      payment: toPaymentInfo(job.payment),
      totals: toDisplayPriceBreakdown(job.totals, rate),
      dispatchAttempts: job.dispatchAttempts,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
    if (job.courierOxyUserId) view.courierOxyUserId = job.courierOxyUserId;
    if (job.companyId) view.companyId = job.companyId;
    if (job.providerRef) view.providerRef = job.providerRef;
    if (job.proofOfDelivery) view.proofOfDelivery = toProofOfDelivery(job.proofOfDelivery);
    // Owner-only: surface the plaintext QR codes for the sender to show/relay.
    if (opts.includeCodes) {
      if (job.pickupCode) view.pickupCode = job.pickupCode;
      if (job.dropoffCode) view.dropoffCode = job.dropoffCode;
    }
    return view;
  });
}

/**
 * Hydrate a single job doc into its `JobView`. Pass `{ includeCodes: true }` ONLY
 * for an owner-scoped (sender) response so the plaintext QR codes are surfaced.
 */
export async function hydrateJob(
  job: JobWithHistory,
  displayCurrency: FiatCurrency,
  opts: HydrateJobOptions = {},
): Promise<JobView> {
  const views = await hydrateJobs([job], displayCurrency, opts);
  const [view] = views;
  if (!view) {
    throw new Error('Job hydration produced no view');
  }
  return view;
}

/**
 * Summarize raw job docs into `JobSummary` DTOs (list views). The FAIR rate is
 * fetched once for the batch. Preserves input order.
 */
export async function summarizeJobs(
  jobs: JobRecord[],
  displayCurrency: FiatCurrency,
): Promise<JobSummary[]> {
  if (jobs.length === 0) {
    return [];
  }
  const rate = await getFairRate(displayCurrency);

  return jobs.map((job) => ({
    id: job.id,
    jobNumber: job.jobNumber,
    shipmentId: job.shipmentId,
    type: job.type,
    fulfillmentType: job.fulfillmentType,
    status: job.status,
    sizeClass: job.parcelSnapshot.sizeClass,
    totals: toDisplayPriceBreakdown(job.totals, rate),
    createdAt: job.createdAt.toISOString(),
  }));
}

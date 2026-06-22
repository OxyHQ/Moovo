/**
 * Job service — booking + lifecycle transitions + courier actions.
 *
 * `bookShipment` turns a selected quote into exactly ONE `Job` (one shipment =
 * one job, no split), idempotent via a sparse-unique `idempotencyKey` (a Mongo
 * 11000 on replay converges on the prior job — cloned from `checkout.service`).
 * For an external-provider quote it calls the provider adapter's `book` and
 * stores the returned reference as `providerRef`.
 *
 * `transition` is the single gate for moving a job between statuses: an atomic
 * compare-and-swap (`findOneAndUpdate` guarded on the CURRENT status) cloned from
 * `order.service.transition` — side-effects (and the in-memory mirror) run ONLY
 * after the CAS wins, so a double-invoke runs them at most once. `JOB_TRANSITIONS`
 * is the allowed-transition graph; an unlisted transition is a CONFLICT.
 *
 * Phase 2 assignment is DIRECT/manual — a booked job is `requested` until a
 * courier `accept`s it (or it is assigned). There is NO offer fan-out (Phase 3).
 */

import type { HydratedDocument } from 'mongoose';
import type {
  JobStatus,
  ProofOfDelivery,
  DeliverInput,
  GeoPoint,
} from '@moovo/shared-types';
import {
  Job,
  type IJob,
  type IJobStatusEvent,
  type IProofOfDelivery,
} from '../models/job.js';
import { Shipment, type IShipment } from '../models/shipment.js';
import { Quote, type IQuote } from '../models/quote.js';
import { Provider, type IProvider } from '../models/provider.js';
import { nextJobNumber } from '../models/counter.js';
import { getAdapter } from './providers/provider-registry.js';
import { config } from '../config/index.js';
import { conflict, forbidden, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * The allowed status transitions. A transition NOT listed under the current
 * status is a CONFLICT. `delivered`/`cancelled` are terminal.
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  requested: ['accepted', 'cancelled'],
  accepted: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'cancelled'],
  in_transit: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/** Options for a `transition` call. */
export interface JobTransitionOptions {
  /** Oxy user id of the actor driving the transition (recorded in history). */
  actorOxyUserId?: string;
  /** Optional free-text note recorded on the status event. */
  note?: string;
  /** Location to attach to the status event (e.g. pickup/delivery point). */
  location?: GeoPoint;
  /** Proof of delivery to attach (only on the `delivered` transition). */
  proofOfDelivery?: IProofOfDelivery;
}

/**
 * Transition a job to `next`, enforcing the allowed-transition graph via an
 * atomic compare-and-swap guarded on the CURRENT status. Only the winning caller
 * (whose CAS matched the pre-transition status) mutates the in-memory doc; a
 * loser's CAS matches nothing and throws CONFLICT. `.save()` is NOT called — the
 * CAS already persisted the change.
 */
export async function transition(
  job: HydratedDocument<IJob>,
  next: JobStatus,
  opts: JobTransitionOptions,
): Promise<IJob> {
  const current = job.status;
  if (!JOB_TRANSITIONS[current].includes(next)) {
    throw conflict(`Cannot transition job from ${current} to ${next}`);
  }

  const event: IJobStatusEvent = { status: next, at: new Date() };
  if (opts.actorOxyUserId) {
    event.byOxyUserId = opts.actorOxyUserId;
  }
  if (opts.note) {
    event.note = opts.note;
  }
  if (opts.location) {
    event.location = { type: 'Point', coordinates: [...opts.location.coordinates] };
  }

  const setFields: Record<string, unknown> = { status: next };
  if (next === 'delivered' && opts.proofOfDelivery) {
    setFields.proofOfDelivery = opts.proofOfDelivery;
  }

  // Atomic CAS gate: only succeeds if the job is still at `current`.
  const updated = await Job.findOneAndUpdate(
    { _id: job._id, status: current },
    { $set: setFields, $push: { statusHistory: event } },
    { new: true },
  );
  if (!updated) {
    throw conflict(`Job ${String(job._id)} was concurrently transitioned`);
  }

  // Mirror the persisted state onto the in-memory doc.
  job.status = next;
  job.statusHistory.push(event);
  if (next === 'delivered' && opts.proofOfDelivery) {
    job.proofOfDelivery = opts.proofOfDelivery;
  }

  log.general.info(
    { jobId: String(job._id), status: next, actor: opts.actorOxyUserId },
    'Job transitioned',
  );
  return job;
}

/** Load a NON-lean job doc by filter (for mutation), or throw NOT_FOUND. */
async function loadJobDoc(filter: Record<string, unknown>): Promise<HydratedDocument<IJob>> {
  const doc = await Job.findOne(filter);
  if (!doc) {
    throw notFound('Job not found');
  }
  return doc;
}

/** Whether a quote is still bookable (active and not lapsed). */
function isQuoteBookable(quote: IQuote): boolean {
  return quote.status === 'active' && quote.expiresAt.getTime() > Date.now();
}

/**
 * Book a selected quote into exactly ONE job. Verifies shipment ownership, that
 * the quote belongs to the shipment and is still bookable, then idempotently
 * creates the job (an `idempotencyKey` 11000 converges on the prior job). An
 * external-provider quote is booked through its adapter; the booking reference is
 * stored as `providerRef`. Marks the quote `selected` and the shipment `booked`.
 */
export async function bookShipment(
  senderOxyUserId: string,
  shipmentId: string,
  quoteId: string,
  idempotencyKey?: string,
): Promise<IJob> {
  const shipment = await Shipment.findById(shipmentId).lean<IShipment | null>();
  if (!shipment) {
    throw notFound('Shipment not found');
  }
  if (String(shipment.senderOxyUserId) !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  if (shipment.status === 'booked' && shipment.jobId) {
    const existing = await Job.findById(shipment.jobId).lean<IJob | null>();
    if (existing) {
      return existing;
    }
  }
  if (shipment.status === 'cancelled' || shipment.status === 'expired') {
    throw conflict(`Shipment is ${shipment.status} and cannot be booked`);
  }

  const quote = await Quote.findById(quoteId).lean<IQuote | null>();
  if (!quote || String(quote.shipmentId) !== shipmentId) {
    throw notFound('Quote not found for this shipment');
  }
  if (!isQuoteBookable(quote)) {
    throw conflict('Quote is no longer active');
  }

  // For an external-provider quote, book through the adapter to get a booking ref.
  const isExternal = quote.source === 'external_provider';
  let providerRef: string | undefined;
  if (isExternal) {
    if (!quote.providerId) {
      throw conflict('External quote is missing its provider');
    }
    const provider = await Provider.findById(quote.providerId).lean<IProvider | null>();
    if (!provider) {
      throw notFound('Provider not found for quote');
    }
    const adapter = getAdapter(provider.key);
    if (!adapter) {
      throw conflict('No adapter registered for the quoted provider');
    }
    const booking = await adapter.book(shipment, quote);
    providerRef = booking.bookingRef;
  }

  const jobNumber = await nextJobNumber();
  const createDoc = {
    jobNumber,
    shipmentId,
    senderOxyUserId,
    type: shipment.type,
    fulfillmentType: isExternal ? ('external_provider' as const) : ('moovo_courier' as const),
    ...(providerRef ? { providerRef } : {}),
    pickupSnapshot: shipment.pickup,
    dropoffSnapshot: shipment.dropoff,
    parcelSnapshot: shipment.parcel,
    quoteSnapshot: quote.priceBreakdown,
    totals: quote.priceBreakdown,
    status: 'requested' as const,
    statusHistory: [{ status: 'requested' as const, at: new Date(), byOxyUserId: senderOxyUserId }],
    payment: { status: 'unpaid' as const, provider: 'oxy_pay' as const },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };

  let job: IJob;
  try {
    const created = await Job.create(createDoc);
    job = created.toObject<IJob>();
  } catch (err) {
    // A duplicate idempotencyKey means a concurrent/replayed booking already
    // created the job — converge on the prior job instead of creating a duplicate.
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000 && idempotencyKey) {
      const prior = await Job.findOne({ idempotencyKey }).lean<IJob | null>();
      if (prior) {
        log.general.warn(
          { senderOxyUserId, shipmentId, idempotencyKey },
          'Concurrent/replayed booking detected; converging on prior job',
        );
        return prior;
      }
    }
    throw err;
  }

  // Mark the quote selected + the shipment booked with its job/quote refs.
  await Quote.updateOne({ _id: quoteId }, { $set: { status: 'selected' } });
  await Shipment.updateOne(
    { _id: shipmentId },
    { $set: { status: 'booked', jobId: String(job._id), quoteRef: quoteId } },
  );

  log.general.info(
    { jobId: String(job._id), shipmentId, fulfillmentType: job.fulfillmentType },
    'Booked shipment into job',
  );
  return job;
}

/** Offset-paginated list parameters for jobs. */
interface ListParams {
  page: number;
  limit: number;
  status?: JobStatus;
}

/** A page of job docs plus the total matching count. */
export interface JobPage {
  data: IJob[];
  total: number;
}

/** List jobs the caller booked (as sender), newest first. */
export async function listForSender(
  senderOxyUserId: string,
  { page, limit, status }: ListParams,
): Promise<JobPage> {
  const filter = { senderOxyUserId, ...(status ? { status } : {}) };
  const [docs, total] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IJob[]>(),
    Job.countDocuments(filter),
  ]);
  return { data: docs, total };
}

/** List jobs assigned to the caller (as courier), newest first. */
export async function listForCourier(
  courierOxyUserId: string,
  { page, limit, status }: ListParams,
): Promise<JobPage> {
  const filter = {
    courierOxyUserId,
    fulfillmentType: 'moovo_courier' as const,
    ...(status ? { status } : {}),
  };
  const [docs, total] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IJob[]>(),
    Job.countDocuments(filter),
  ]);
  return { data: docs, total };
}

/**
 * Get a single job visible to the caller — either as its sender OR as its
 * assigned courier. Throws NOT_FOUND when neither relationship holds.
 */
export async function getVisible(oxyUserId: string, id: string): Promise<IJob> {
  const doc = await Job.findById(id).lean<IJob | null>();
  if (
    !doc ||
    (String(doc.senderOxyUserId) !== oxyUserId &&
      String(doc.courierOxyUserId ?? '') !== oxyUserId)
  ) {
    throw notFound('Job not found');
  }
  return doc;
}

/**
 * A courier accepts a `requested` Moovo-courier job. Claimable when the job is
 * unassigned OR already assigned to this courier; on a successful accept the
 * courier is assigned (when not yet set) and the job moves `requested → accepted`.
 */
export async function accept(courierOxyUserId: string, jobId: string): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  if (doc.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }
  const assignee = doc.courierOxyUserId ? String(doc.courierOxyUserId) : undefined;
  if (assignee && assignee !== courierOxyUserId) {
    throw forbidden('This job is assigned to another courier');
  }

  // Assign the courier (idempotent) before the lifecycle transition.
  if (!assignee) {
    doc.courierOxyUserId = courierOxyUserId;
    await Job.updateOne({ _id: jobId }, { $set: { courierOxyUserId } });
  }

  await transition(doc, 'accepted', { actorOxyUserId: courierOxyUserId, note: 'accepted by courier' });
  return doc.toObject<IJob>();
}

/** Assert the job is a Moovo-courier job assigned to `courierOxyUserId`. */
function assertAssignedCourier(job: HydratedDocument<IJob>, courierOxyUserId: string): void {
  if (job.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }
  if (String(job.courierOxyUserId ?? '') !== courierOxyUserId) {
    throw forbidden('This job is not assigned to you');
  }
}

/** A courier marks the assigned job picked up (`accepted → picked_up`). */
export async function pickup(
  courierOxyUserId: string,
  jobId: string,
  location?: GeoPoint,
): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  assertAssignedCourier(doc, courierOxyUserId);
  await transition(doc, 'picked_up', {
    actorOxyUserId: courierOxyUserId,
    ...(location ? { location } : {}),
  });
  return doc.toObject<IJob>();
}

/** A courier marks the assigned job in transit (`picked_up → in_transit`). */
export async function startTransit(
  courierOxyUserId: string,
  jobId: string,
  location?: GeoPoint,
): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  assertAssignedCourier(doc, courierOxyUserId);
  await transition(doc, 'in_transit', {
    actorOxyUserId: courierOxyUserId,
    ...(location ? { location } : {}),
  });
  return doc.toObject<IJob>();
}

/**
 * A courier delivers the assigned job (`in_transit → delivered`), attaching the
 * proof of delivery captured at the doorstep.
 */
export async function deliver(
  courierOxyUserId: string,
  jobId: string,
  input: DeliverInput,
  location?: GeoPoint,
): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  assertAssignedCourier(doc, courierOxyUserId);

  const proof: IProofOfDelivery = { at: new Date() };
  if (input.photoFileId) proof.photoFileId = input.photoFileId;
  if (input.signatureFileId) proof.signatureFileId = input.signatureFileId;
  if (input.note) proof.note = input.note;
  if (input.recipientName) proof.recipientName = input.recipientName;

  await transition(doc, 'delivered', {
    actorOxyUserId: courierOxyUserId,
    proofOfDelivery: proof,
    ...(location ? { location } : {}),
  });
  return doc.toObject<IJob>();
}

/**
 * Record a courier location ping on the assigned job, capped to the most recent
 * `config.jobs.maxLocationPings` via a `$slice` push (oldest dropped).
 */
export async function pingLocation(
  courierOxyUserId: string,
  jobId: string,
  location: GeoPoint,
): Promise<IJob> {
  const job = await Job.findOne({ _id: jobId });
  if (!job) {
    throw notFound('Job not found');
  }
  if (job.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }
  if (String(job.courierOxyUserId ?? '') !== courierOxyUserId) {
    throw forbidden('This job is not assigned to you');
  }

  const ping = { location: { type: 'Point' as const, coordinates: [...location.coordinates] }, at: new Date() };
  const updated = await Job.findByIdAndUpdate(
    jobId,
    {
      $push: {
        locationPings: { $each: [ping], $slice: -config.jobs.maxLocationPings },
      },
    },
    { new: true },
  ).lean<IJob | null>();
  if (!updated) {
    throw notFound('Job not found');
  }
  return updated;
}

/** Get a single mutable job doc visible to the caller (sender or courier) for a transition. */
async function loadVisibleJobDoc(
  oxyUserId: string,
  id: string,
): Promise<HydratedDocument<IJob>> {
  const doc = await loadJobDoc({ _id: id });
  if (
    String(doc.senderOxyUserId) !== oxyUserId &&
    String(doc.courierOxyUserId ?? '') !== oxyUserId
  ) {
    throw notFound('Job not found');
  }
  return doc;
}

/** Cancel a job the caller is party to (sender or assigned courier). */
export async function cancel(oxyUserId: string, jobId: string): Promise<IJob> {
  const doc = await loadVisibleJobDoc(oxyUserId, jobId);
  await transition(doc, 'cancelled', { actorOxyUserId: oxyUserId, note: 'cancelled' });
  return doc.toObject<IJob>();
}

/** Re-export for callers that build the POD DTO (kept in one place). */
export type { ProofOfDelivery };

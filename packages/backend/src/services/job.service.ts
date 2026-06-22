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
 * Phase 3 assignment is REAL-TIME DISPATCH: `bookShipment` fans the job out to
 * nearby couriers as time-boxed offers (`dispatch.service`). A courier accepts a
 * specific OFFER (see `accept`, offer-gated) and the job moves `offered →
 * accepted` via an atomic CAS — first writer wins. The legacy direct
 * `requested → accepted` edge is retained for manual assignment.
 */

import type { HydratedDocument } from 'mongoose';
import type {
  JobStatus,
  ProofOfDelivery,
  DeliverInput,
  ScanInput,
  GeoPoint,
} from '@moovo/shared-types';
import {
  Job,
  type IJob,
  type IJobStatusEvent,
  type IProofOfDelivery,
} from '../models/job.js';
import { JobOffer } from '../models/job-offer.js';
import { Shipment, type IShipment } from '../models/shipment.js';
import { Quote, type IQuote } from '../models/quote.js';
import { Provider, type IProvider } from '../models/provider.js';
import { CourierProfile } from '../models/courier-profile.js';
import { nextJobNumber } from '../models/counter.js';
import { getAdapter } from './providers/provider-registry.js';
import { emitJobStatus, emitJobLocation } from './job-events.service.js';
import { verifyCode, generateCode, hashCode } from '../utils/job-codes.js';
import { EVENTS } from '../lib/socket-events.js';
import { getIO } from '../socket.js';
import { config } from '../config/index.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * The allowed status transitions. A transition NOT listed under the current
 * status is a CONFLICT. `delivered`/`cancelled` are terminal.
 *
 * `requested → offered` is the dispatch fan-out; `offered → requested` is the
 * re-dispatch fallback when all offers expire unaccepted. The direct
 * `requested → accepted` edge is kept for manual assignment (courier acceptance
 * is offer-gated in `accept`).
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  requested: ['offered', 'accepted', 'cancelled'],
  offered: ['accepted', 'cancelled', 'requested'],
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

  // For a Moovo-courier job, mint the two single-use QR proof codes at booking.
  // Store the HASH (verify source the courier scans against) AND the plaintext
  // (surfaced ONLY to the owner/sender at hydration). External-provider jobs have
  // no Moovo QR proof — the provider owns delivery.
  const pickupCode = isExternal ? undefined : generateCode();
  const dropoffCode = isExternal ? undefined : generateCode();

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
    dispatchAttempts: 0,
    ...(pickupCode ? { pickupCode, pickupCodeHash: hashCode(pickupCode) } : {}),
    ...(dropoffCode ? { dropoffCode, dropoffCodeHash: hashCode(dropoffCode) } : {}),
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

  // Real-time dispatch (Moovo-courier path only). Best-effort: booking succeeds
  // regardless — a dispatch failure is logged and the offer-expiry sweep recovers
  // a still-`requested` job. The dynamic import breaks the module cycle.
  if (!isExternal) {
    try {
      const { dispatchJob } = await import('./dispatch.service.js');
      await dispatchJob(String(job._id));
    } catch (err) {
      log.general.warn(
        { err, jobId: String(job._id) },
        'Initial dispatch failed (booking kept; sweep will retry)',
      );
    }
  }

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
 * Recompute a courier's denormalized acceptance rate after they accept an offer:
 * the share of offers ever addressed to them that they accepted,
 * `accepted / (accepted + declined + expired + superseded)`. Counted over the
 * `JobOffer` history so it is drift-proof. Best-effort: a recompute failure is
 * logged and never blocks the accept.
 */
async function recomputeAcceptanceRate(courierOxyUserId: string): Promise<void> {
  try {
    const counts = await JobOffer.aggregate<{ _id: string; count: number }>([
      { $match: { courierOxyUserId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    let accepted = 0;
    let resolved = 0;
    for (const c of counts) {
      // `offered` offers are still in-flight — exclude from the denominator.
      if (c._id === 'offered') {
        continue;
      }
      resolved += c.count;
      if (c._id === 'accepted') {
        accepted += c.count;
      }
    }
    if (resolved === 0) {
      return;
    }
    await CourierProfile.updateOne(
      { oxyUserId: courierOxyUserId },
      { $set: { acceptanceRate: accepted / resolved } },
    );
  } catch (err) {
    log.general.warn({ err, courierOxyUserId }, 'Failed to recompute acceptance rate (best-effort)');
  }
}

/**
 * A courier accepts a job they were OFFERED. Offer-gated: the caller MUST hold a
 * live (`offered`) {@link JobOffer} for this job, else FORBIDDEN. The accept is an
 * atomic CAS guarded on `status: 'offered'` — the FIRST courier to win the CAS
 * gets the job (`offered → accepted`, courier assigned in the same update); a lost
 * CAS (a sibling accepted first) throws CONFLICT (a late accept). On a win: the
 * winner's offer → `accepted`, sibling `offered` offers → `superseded` (their
 * holders get a `job:offer_taken` event), the sender gets `job:accepted`, and the
 * courier flips to `on_job` with a recomputed acceptance rate.
 */
export async function accept(courierOxyUserId: string, jobId: string): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  if (doc.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }

  // Offer gate: the caller must hold a live offer for this job.
  const myOffer = await JobOffer.findOne({ jobId, courierOxyUserId, status: 'offered' });
  if (!myOffer) {
    throw forbidden('You do not have a live offer for this job');
  }

  // Atomic CAS: first writer wins. Assign the courier in the same update.
  const event: IJobStatusEvent = {
    status: 'accepted',
    at: new Date(),
    byOxyUserId: courierOxyUserId,
    note: 'accepted by courier',
  };
  const won = await Job.findOneAndUpdate(
    { _id: jobId, status: 'offered' },
    { $set: { status: 'accepted', courierOxyUserId }, $push: { statusHistory: event } },
    { new: true },
  ).lean<IJob | null>();
  if (!won) {
    // Lost the race — another courier accepted first (or it was cancelled).
    await JobOffer.updateOne({ _id: myOffer._id }, { $set: { status: 'superseded' } });
    throw conflict('This job was already accepted by another courier');
  }

  // Winner's offer accepted; all sibling live offers superseded.
  await JobOffer.updateOne({ _id: myOffer._id }, { $set: { status: 'accepted' } });
  const siblings = await JobOffer.find({
    jobId,
    status: 'offered',
    _id: { $ne: myOffer._id },
  })
    .select({ courierOxyUserId: 1 })
    .lean<{ courierOxyUserId: string }[]>();
  if (siblings.length > 0) {
    await JobOffer.updateMany(
      { jobId, status: 'offered', _id: { $ne: myOffer._id } },
      { $set: { status: 'superseded' } },
    );
  }

  // Courier is now busy; recompute their acceptance rate from offer history.
  await CourierProfile.updateOne(
    { oxyUserId: courierOxyUserId },
    { $set: { onlineStatus: 'on_job' } },
  );
  await recomputeAcceptanceRate(courierOxyUserId);

  // Notify the losing candidates + the sender.
  const io = getIO();
  if (io) {
    for (const sibling of siblings) {
      io.to(`user:${String(sibling.courierOxyUserId)}`).emit(EVENTS.JOB_OFFER_TAKEN, {
        jobId,
      });
    }
  }
  await emitJobStatus(won, 'accepted');

  return won;
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
  const job = doc.toObject<IJob>();
  await emitJobStatus(job, 'picked_up');
  return job;
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
  const job = doc.toObject<IJob>();
  await emitJobStatus(job, 'in_transit');
  return job;
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
  const job = doc.toObject<IJob>();
  await emitJobStatus(job, 'delivered');
  return job;
}

/**
 * A courier proves pickup or delivery by scanning the sender's / recipient's QR
 * code (or typing the code). Assigned-courier only. Validates the leg's status
 * precondition (`pickup`: `accepted → picked_up`; `dropoff`: `in_transit →
 * delivered`) and the scanned `code` against the job's stored hash for that leg.
 * A wrong code is a 400 ("Invalid pickup/dropoff code") — the expected code is
 * NEVER echoed. A wrong status is a CONFLICT. On a `dropoff` success a
 * scanned-proof `proofOfDelivery` is recorded. Emits the lifecycle event.
 */
export async function scanJob(
  courierOxyUserId: string,
  jobId: string,
  input: ScanInput,
): Promise<IJob> {
  const doc = await loadJobDoc({ _id: jobId });
  assertAssignedCourier(doc, courierOxyUserId);

  if (input.leg === 'pickup') {
    if (doc.status !== 'accepted') {
      throw conflict(`Cannot scan pickup while job is ${doc.status}`);
    }
    if (!verifyCode(input.code, doc.pickupCodeHash ?? '')) {
      throw validationError('Invalid pickup code');
    }
    await transition(doc, 'picked_up', {
      actorOxyUserId: courierOxyUserId,
      note: 'pickup scanned',
    });
    const job = doc.toObject<IJob>();
    await emitJobStatus(job, 'picked_up');
    return job;
  }

  // dropoff leg
  if (doc.status !== 'in_transit') {
    throw conflict(`Cannot scan dropoff while job is ${doc.status}`);
  }
  if (!verifyCode(input.code, doc.dropoffCodeHash ?? '')) {
    throw validationError('Invalid dropoff code');
  }
  const proof: IProofOfDelivery = { at: new Date(), note: 'scanned' };
  if (input.photoFileId) proof.photoFileId = input.photoFileId;
  await transition(doc, 'delivered', {
    actorOxyUserId: courierOxyUserId,
    proofOfDelivery: proof,
  });
  const job = doc.toObject<IJob>();
  await emitJobStatus(job, 'delivered');
  return job;
}

/** Job statuses during which a live courier location ping is meaningful. */
const TRACKABLE_STATUSES: readonly JobStatus[] = ['accepted', 'picked_up', 'in_transit'];

/**
 * Record a courier location ping on the assigned job, capped to the most recent
 * `config.jobs.maxLocationPings` via a `$slice` push (oldest dropped). Only valid
 * while the job is ACTIVE (accepted/picked_up/in_transit) — a ping on a not-yet-
 * accepted or terminal job is a CONFLICT. On success the sender receives a live
 * `job:location` event so they can track the courier in real time.
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
  if (!TRACKABLE_STATUSES.includes(job.status)) {
    throw conflict(`Cannot record location while job is ${job.status}`);
  }

  const [lng, lat] = location.coordinates;
  const ping = { location: { type: 'Point' as const, coordinates: [lng, lat] }, at: new Date() };
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

  emitJobLocation(updated, lng, lat);
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

/**
 * Cancel a job the caller is party to (sender or assigned courier). Supersedes
 * any live offers for the job (no courier can still accept a cancelled job) and
 * emits the `job:cancelled` lifecycle event.
 */
export async function cancel(oxyUserId: string, jobId: string): Promise<IJob> {
  const doc = await loadVisibleJobDoc(oxyUserId, jobId);
  await transition(doc, 'cancelled', { actorOxyUserId: oxyUserId, note: 'cancelled' });
  await JobOffer.updateMany(
    { jobId, status: 'offered' },
    { $set: { status: 'superseded' } },
  );
  const job = doc.toObject<IJob>();
  await emitJobStatus(job, 'cancelled');
  return job;
}

/** Re-export for callers that build the POD DTO (kept in one place). */
export type { ProofOfDelivery };

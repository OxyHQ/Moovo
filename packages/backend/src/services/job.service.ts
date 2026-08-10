/**
 * Job service — booking + lifecycle transitions + courier actions.
 *
 * `bookShipment` turns a selected quote into exactly ONE job (one shipment =
 * one job, no split), idempotent via a partial-unique `idempotencyKey`. For an
 * external-provider quote it calls the provider adapter's `book` and stores the
 * returned reference as `providerRef`.
 *
 * `transition` is the single gate for moving a job between statuses: an atomic
 * compare-and-swap guarded on the CURRENT status, so a double-invoke runs the
 * side effects at most once. `JOB_TRANSITIONS` is the allowed-transition graph;
 * an unlisted transition is a CONFLICT.
 *
 * Phase 3 assignment is REAL-TIME DISPATCH: `bookShipment` fans the job out to
 * nearby couriers as time-boxed offers (`dispatch.service`). A courier accepts a
 * specific OFFER (see `accept`, offer-gated) and the job moves `offered →
 * accepted` via an atomic CAS — first writer wins. The legacy direct
 * `requested → accepted` edge is retained for manual assignment.
 *
 * ## Two things the Postgres port changed on purpose
 *
 * **`transition` no longer patches an in-memory copy.** The source ran the CAS
 * and then hand-applied the same change to the hydrated document, so callers
 * read a mirror rather than the persisted row — two representations of one
 * fact, kept in step by whoever remembered to. It now returns the row the CAS
 * itself produced, and callers use the return value.
 *
 * **Booking is ONE transaction.** The source wrote the job, then marked the
 * quote selected, then marked the shipment booked, as three independent
 * operations. A failure after the first left the shipment `quoted` with no
 * `jobId` — so the "already booked" early return never fired, and every retry
 * converged on the prior job and returned BEFORE the two marks, permanently.
 * One transaction removes the window; the provider's `book` call stays outside
 * it, because an HTTP round trip does not belong inside an open transaction.
 */

import { findProviderById } from '../db/transport/providerRepository.js';
import type {
  JobStatus,
  ProofOfDelivery,
  DeliverInput,
  ScanInput,
  GeoPoint,
} from '@moovo/shared-types';
import { getDb } from '../db/postgres.js';
import {
  attachHistory,
  casJobAccepted,
  casJobStatus,
  countJobs,
  findJobById,
  findJobByIdempotencyKey,
  findJobWithHistory,
  insertJobIfAbsent,
  insertJobStatusEvent,
  insertLocationPing,
  listJobs,
  type JobListFilter,
} from '../db/transport/jobRepository.js';
import type {
  JobProofOfDeliveryValue,
  JobRecord,
  JobWithHistory,
} from '../db/transport/jobShape.js';
import {
  countOfferOutcomesForCourier,
  findLiveOfferForCourier,
  setOfferStatus,
  supersedeLiveOffers,
} from '../db/transport/jobOfferRepository.js';
import {
  findShipmentById,
  markShipmentBooked,
} from '../db/transport/shipmentRepository.js';
import {
  findQuoteById,
  markQuoteSelected,
  type QuoteRecord,
} from '../db/transport/quoteRepository.js';
import {
  markCourierOnJob,
  updateCourierAcceptanceRate,
} from '../db/fleet/courierProfileRepository.js';
import { nextJobNumber } from '../db/sequences/numberRepository.js';
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
  proofOfDelivery?: JobProofOfDeliveryValue;
}

/**
 * Transition a job to `next`, enforcing the allowed-transition graph via an
 * atomic compare-and-swap guarded on the CURRENT status.
 *
 * The CAS and the audit entry commit TOGETHER. Mongo did both in one document
 * update, so a transition with no trail entry was unrepresentable; two
 * statements can drift, and a status that moved with nothing saying so is the
 * worse of the two failures because nothing reports it.
 *
 * Returns the row the CAS produced. A caller that loses the race is told
 * nothing happened rather than handed a job somebody else moved.
 */
export async function transition(
  job: JobRecord,
  next: JobStatus,
  opts: JobTransitionOptions,
): Promise<JobRecord> {
  const current = job.status;
  if (!JOB_TRANSITIONS[current].includes(next)) {
    throw conflict(`Cannot transition job from ${current} to ${next}`);
  }

  const updated = await getDb().transaction(async (tx) => {
    const row = await casJobStatus(
      {
        jobId: job.id,
        from: current,
        to: next,
        ...(next === 'delivered' && opts.proofOfDelivery
          ? { proofOfDelivery: opts.proofOfDelivery }
          : {}),
      },
      tx,
    );
    if (!row) {
      return null;
    }
    await insertJobStatusEvent(
      {
        jobId: job.id,
        status: next,
        at: new Date(),
        ...(opts.actorOxyUserId ? { byOxyUserId: opts.actorOxyUserId } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        ...(opts.location
          ? { location: { type: 'Point', coordinates: [...opts.location.coordinates] } }
          : {}),
      },
      tx,
    );
    return row;
  });

  if (!updated) {
    throw conflict(`Job ${job.id} was concurrently transitioned`);
  }

  log.general.info(
    { jobId: job.id, status: next, actor: opts.actorOxyUserId },
    'Job transitioned',
  );
  return updated;
}

/** Load a job by id for mutation, or throw NOT_FOUND. */
async function loadJob(jobId: string): Promise<JobRecord> {
  const job = await findJobById(jobId);
  if (!job) {
    throw notFound('Job not found');
  }
  return job;
}

/**
 * Attach both trails to a job an action just produced.
 *
 * Every action response is a detail view, so it carries the audit trail — and
 * the trail it must carry includes the entry the action itself just wrote,
 * which is why this re-reads rather than appending to a copy in memory.
 */
async function withHistory(job: JobRecord): Promise<JobWithHistory> {
  return attachHistory(job, config.jobs.maxLocationPings);
}

/** Whether a quote is still bookable (active and not lapsed). */
function isQuoteBookable(quote: QuoteRecord): boolean {
  return quote.status === 'active' && quote.expiresAt.getTime() > Date.now();
}

/**
 * Book a selected quote into exactly ONE job. Verifies shipment ownership, that
 * the quote belongs to the shipment and is still bookable, then idempotently
 * creates the job. An external-provider quote is booked through its adapter;
 * the booking reference is stored as `providerRef`. Marks the quote `selected`
 * and the shipment `booked` in the SAME transaction as the job — see the module
 * header for the failure that split writes left behind.
 */
export async function bookShipment(
  senderOxyUserId: string,
  shipmentId: string,
  quoteId: string,
  idempotencyKey?: string,
): Promise<JobWithHistory> {
  const shipment = await findShipmentById(shipmentId);
  if (!shipment) {
    throw notFound('Shipment not found');
  }
  if (shipment.senderOxyUserId !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  if (shipment.status === 'booked' && shipment.jobId) {
    const existing = await findJobWithHistory(shipment.jobId, config.jobs.maxLocationPings);
    if (existing) {
      return existing;
    }
  }
  if (shipment.status === 'cancelled' || shipment.status === 'expired') {
    throw conflict(`Shipment is ${shipment.status} and cannot be booked`);
  }

  const quote = await findQuoteById(quoteId);
  if (!quote || quote.shipmentId !== shipmentId) {
    throw notFound('Quote not found for this shipment');
  }
  if (!isQuoteBookable(quote)) {
    throw conflict('Quote is no longer active');
  }

  // For an external-provider quote, book through the adapter to get a booking
  // ref. Outside the transaction below: an outbound HTTP call inside an open
  // transaction holds a connection for as long as somebody else's server takes.
  const isExternal = quote.source === 'external_provider';
  let providerRef: string | undefined;
  if (isExternal) {
    if (!quote.providerId) {
      throw conflict('External quote is missing its provider');
    }
    const provider = await findProviderById(quote.providerId);
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
  const { job, converged } = await getDb().transaction(async (tx) => {
    const created = await insertJobIfAbsent(
      {
        jobNumber,
        shipmentId,
        senderOxyUserId,
        type: shipment.type,
        fulfillmentType: isExternal ? 'external_provider' : 'moovo_courier',
        providerRef,
        pickupSnapshot: shipment.pickup,
        dropoffSnapshot: shipment.dropoff,
        parcelSnapshot: shipment.parcel,
        quoteSnapshot: quote.priceBreakdown,
        totals: quote.priceBreakdown,
        pickupCode,
        ...(pickupCode ? { pickupCodeHash: hashCode(pickupCode) } : {}),
        dropoffCode,
        ...(dropoffCode ? { dropoffCodeHash: hashCode(dropoffCode) } : {}),
        idempotencyKey,
      },
      tx,
    );

    // An empty insert IS the "this key already booked a job" answer — see
    // `insertJobIfAbsent`. Converge on the prior job rather than creating a
    // second one, and touch nothing: the booking that won owns the quote and
    // the shipment, and it marked both in its own transaction.
    if (!created) {
      if (!idempotencyKey) {
        throw new Error('A job insert was cancelled with no idempotency key to converge on');
      }
      const prior = await findJobByIdempotencyKey(idempotencyKey, tx);
      if (!prior) {
        // The conflicting row must exist for the insert to have been cancelled.
        // Refusing loudly rather than falling through to a second create, which
        // would be the duplicate the whole mechanism exists to prevent.
        throw new Error(
          `Job insert conflicted on idempotency key ${idempotencyKey} but no prior job was found`,
        );
      }
      log.general.warn(
        { senderOxyUserId, shipmentId, idempotencyKey },
        'Concurrent/replayed booking detected; converging on prior job',
      );
      return { job: prior, converged: true };
    }

    await insertJobStatusEvent(
      {
        jobId: created.id,
        status: 'requested',
        at: new Date(),
        byOxyUserId: senderOxyUserId,
      },
      tx,
    );
    await markQuoteSelected(quoteId, tx);
    await markShipmentBooked(shipmentId, { jobId: created.id, quoteRef: quoteId }, tx);
    return { job: created, converged: false };
  });

  if (converged) {
    return withHistory(job);
  }

  log.general.info(
    { jobId: job.id, shipmentId, fulfillmentType: job.fulfillmentType },
    'Booked shipment into job',
  );

  // Real-time dispatch (Moovo-courier path only). Best-effort: booking succeeds
  // regardless — a dispatch failure is logged and the offer-expiry sweep recovers
  // a still-`requested` job. The dynamic import breaks the module cycle.
  if (!isExternal) {
    try {
      const { dispatchJob } = await import('./dispatch.service.js');
      await dispatchJob(job.id);
    } catch (err) {
      log.general.warn(
        { err, jobId: job.id },
        'Initial dispatch failed (booking kept; sweep will retry)',
      );
    }
  }

  // Re-read rather than returning the row the insert produced: dispatch may have
  // moved the job to `offered` and appended to its trail, and the response is a
  // detail view of the job as it now stands.
  return (await findJobWithHistory(job.id, config.jobs.maxLocationPings)) ?? withHistory(job);
}

/** Offset-paginated list parameters for jobs. */
interface ListParams {
  page: number;
  limit: number;
  status?: JobStatus;
}

/**
 * A page of jobs plus the total matching count.
 *
 * `JobRecord`, deliberately NOT `JobWithHistory`: the list view summarises and
 * reads neither trail, so loading them would be a second query per page bought
 * for nothing — and the type is what stops a caller handing these to
 * `hydrateJobs`, which would render every job with an empty audit trail.
 */
export interface JobPage {
  data: JobRecord[];
  total: number;
}

async function listPage(filter: JobListFilter, { page, limit }: ListParams): Promise<JobPage> {
  const [data, total] = await Promise.all([
    listJobs(filter, { page, limit }),
    countJobs(filter),
  ]);
  return { data, total };
}

/** List jobs the caller booked (as sender), newest first. */
export async function listForSender(
  senderOxyUserId: string,
  params: ListParams,
): Promise<JobPage> {
  return listPage({ senderOxyUserId, status: params.status }, params);
}

/** List jobs assigned to the caller (as courier), newest first. */
export async function listForCourier(
  courierOxyUserId: string,
  params: ListParams,
): Promise<JobPage> {
  return listPage(
    { courierOxyUserId, fulfillmentType: 'moovo_courier', status: params.status },
    params,
  );
}

/**
 * Get a single job visible to the caller — either as its sender OR as its
 * assigned courier. Throws NOT_FOUND when neither relationship holds.
 */
export async function getVisible(oxyUserId: string, id: string): Promise<JobWithHistory> {
  const job = await findJobById(id);
  if (!job || !isParty(job, oxyUserId)) {
    throw notFound('Job not found');
  }
  return withHistory(job);
}

/** Whether this account is the job's sender or its assigned courier. */
function isParty(job: JobRecord, oxyUserId: string): boolean {
  return job.senderOxyUserId === oxyUserId || job.courierOxyUserId === oxyUserId;
}

/**
 * Recompute a courier's denormalized acceptance rate after they accept an offer:
 * the share of offers ever addressed to them that they accepted,
 * `accepted / (accepted + declined + expired + superseded)`. Counted over the
 * offer history so it is drift-proof. Best-effort: a recompute failure is
 * logged and never blocks the accept.
 */
async function recomputeAcceptanceRate(courierOxyUserId: string): Promise<void> {
  try {
    const outcomes = await countOfferOutcomesForCourier(courierOxyUserId);
    let accepted = 0;
    let resolved = 0;
    for (const outcome of outcomes) {
      // `offered` offers are still in-flight — exclude from the denominator.
      if (outcome.status === 'offered') {
        continue;
      }
      resolved += outcome.count;
      if (outcome.status === 'accepted') {
        accepted += outcome.count;
      }
    }
    if (resolved === 0) {
      return;
    }
    await updateCourierAcceptanceRate(courierOxyUserId, accepted / resolved);
  } catch (err) {
    log.general.warn({ err, courierOxyUserId }, 'Failed to recompute acceptance rate (best-effort)');
  }
}

/**
 * A courier accepts a job they were OFFERED. Offer-gated: the caller MUST hold a
 * live (`offered`) offer for this job, else FORBIDDEN. The accept is an atomic
 * CAS guarded on `status: 'offered'` — the FIRST courier to win the CAS gets the
 * job (`offered → accepted`, courier assigned in the same update); a lost CAS (a
 * sibling accepted first) throws CONFLICT (a late accept). On a win: the
 * winner's offer → `accepted`, sibling `offered` offers → `superseded` (their
 * holders get a `job:offer_taken` event), the sender gets `job:accepted`, and the
 * courier flips to `on_job` with a recomputed acceptance rate.
 */
export async function accept(courierOxyUserId: string, jobId: string): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  if (job.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }

  // Offer gate: the caller must hold a live offer for this job.
  const myOffer = await findLiveOfferForCourier(jobId, courierOxyUserId);
  if (!myOffer) {
    throw forbidden('You do not have a live offer for this job');
  }

  // Atomic CAS: first writer wins, and the assignment rides the same statement
  // so a loser can never apply it. The audit entry commits with the CAS.
  const won = await getDb().transaction(async (tx) => {
    const row = await casJobAccepted(jobId, courierOxyUserId, tx);
    if (!row) {
      return null;
    }
    await insertJobStatusEvent(
      {
        jobId,
        status: 'accepted',
        at: new Date(),
        byOxyUserId: courierOxyUserId,
        note: 'accepted by courier',
      },
      tx,
    );
    return row;
  });

  if (!won) {
    // Lost the race — another courier accepted first (or it was cancelled).
    await setOfferStatus(myOffer.id, 'superseded');
    throw conflict('This job was already accepted by another courier');
  }

  // Winner's offer accepted; all sibling live offers superseded. The supersede
  // RETURNS whose offers it took, so the notification list is exactly the set
  // the statement actually changed.
  await setOfferStatus(myOffer.id, 'accepted');
  const supersededCouriers = await supersedeLiveOffers(jobId, myOffer.id);

  // Courier is now busy; recompute their acceptance rate from offer history.
  await markCourierOnJob(courierOxyUserId);
  await recomputeAcceptanceRate(courierOxyUserId);

  // Notify the losing candidates + the sender.
  const io = getIO();
  if (io) {
    for (const courierId of supersededCouriers) {
      io.to(`user:${courierId}`).emit(EVENTS.JOB_OFFER_TAKEN, { jobId });
    }
  }
  await emitJobStatus(won, 'accepted');

  return withHistory(won);
}

/** Assert the job is a Moovo-courier job assigned to `courierOxyUserId`. */
function assertAssignedCourier(job: JobRecord, courierOxyUserId: string): void {
  if (job.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }
  if (job.courierOxyUserId !== courierOxyUserId) {
    throw forbidden('This job is not assigned to you');
  }
}

/** A courier marks the assigned job picked up (`accepted → picked_up`). */
export async function pickup(
  courierOxyUserId: string,
  jobId: string,
  location?: GeoPoint,
): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  assertAssignedCourier(job, courierOxyUserId);
  const moved = await transition(job, 'picked_up', {
    actorOxyUserId: courierOxyUserId,
    ...(location ? { location } : {}),
  });
  await emitJobStatus(moved, 'picked_up');
  return withHistory(moved);
}

/** A courier marks the assigned job in transit (`picked_up → in_transit`). */
export async function startTransit(
  courierOxyUserId: string,
  jobId: string,
  location?: GeoPoint,
): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  assertAssignedCourier(job, courierOxyUserId);
  const moved = await transition(job, 'in_transit', {
    actorOxyUserId: courierOxyUserId,
    ...(location ? { location } : {}),
  });
  await emitJobStatus(moved, 'in_transit');
  return withHistory(moved);
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
): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  assertAssignedCourier(job, courierOxyUserId);

  const proof: JobProofOfDeliveryValue = { at: new Date() };
  if (input.photoFileId) proof.photoFileId = input.photoFileId;
  if (input.signatureFileId) proof.signatureFileId = input.signatureFileId;
  if (input.note) proof.note = input.note;
  if (input.recipientName) proof.recipientName = input.recipientName;

  const moved = await transition(job, 'delivered', {
    actorOxyUserId: courierOxyUserId,
    proofOfDelivery: proof,
    ...(location ? { location } : {}),
  });
  await emitJobStatus(moved, 'delivered');
  return withHistory(moved);
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
): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  assertAssignedCourier(job, courierOxyUserId);

  if (input.leg === 'pickup') {
    if (job.status !== 'accepted') {
      throw conflict(`Cannot scan pickup while job is ${job.status}`);
    }
    if (!verifyCode(input.code, job.pickupCodeHash ?? '')) {
      throw validationError('Invalid pickup code');
    }
    const moved = await transition(job, 'picked_up', {
      actorOxyUserId: courierOxyUserId,
      note: 'pickup scanned',
    });
    await emitJobStatus(moved, 'picked_up');
    return withHistory(moved);
  }

  // dropoff leg
  if (job.status !== 'in_transit') {
    throw conflict(`Cannot scan dropoff while job is ${job.status}`);
  }
  if (!verifyCode(input.code, job.dropoffCodeHash ?? '')) {
    throw validationError('Invalid dropoff code');
  }
  const proof: JobProofOfDeliveryValue = { at: new Date(), note: 'scanned' };
  if (input.photoFileId) proof.photoFileId = input.photoFileId;
  const moved = await transition(job, 'delivered', {
    actorOxyUserId: courierOxyUserId,
    proofOfDelivery: proof,
  });
  await emitJobStatus(moved, 'delivered');
  return withHistory(moved);
}

/** Job statuses during which a live courier location ping is meaningful. */
const TRACKABLE_STATUSES: readonly JobStatus[] = ['accepted', 'picked_up', 'in_transit'];

/**
 * Record a courier location ping on the assigned job. Only valid while the job
 * is ACTIVE (accepted/picked_up/in_transit) — a ping on a not-yet-accepted or
 * terminal job is a CONFLICT. On success the sender receives a live
 * `job:location` event so they can track the courier in real time.
 *
 * The source capped the STORED trail at `config.jobs.maxLocationPings` with a
 * `$slice` push, because an unbounded array grows one Mongo document without
 * bound. A row has no such limit, so the cap moves to the READ — the response
 * carries the same most-recent N and nothing is destroyed to produce it.
 */
export async function pingLocation(
  courierOxyUserId: string,
  jobId: string,
  location: GeoPoint,
): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  if (job.fulfillmentType !== 'moovo_courier') {
    throw conflict('This job is fulfilled by an external provider');
  }
  if (job.courierOxyUserId !== courierOxyUserId) {
    throw forbidden('This job is not assigned to you');
  }
  if (!TRACKABLE_STATUSES.includes(job.status)) {
    throw conflict(`Cannot record location while job is ${job.status}`);
  }

  const [longitude, latitude] = location.coordinates;
  await insertLocationPing(jobId, { longitude, latitude, at: new Date() });

  emitJobLocation(job, longitude, latitude);
  // Read the trails AFTER the ping landed, so the response carries it.
  return withHistory(job);
}

/**
 * Cancel a job the caller is party to (sender or assigned courier). Supersedes
 * any live offers for the job (no courier can still accept a cancelled job) and
 * emits the `job:cancelled` lifecycle event.
 */
export async function cancel(oxyUserId: string, jobId: string): Promise<JobWithHistory> {
  const job = await loadJob(jobId);
  if (!isParty(job, oxyUserId)) {
    throw notFound('Job not found');
  }
  const moved = await transition(job, 'cancelled', {
    actorOxyUserId: oxyUserId,
    note: 'cancelled',
  });
  await supersedeLiveOffers(jobId, undefined);
  await emitJobStatus(moved, 'cancelled');
  return withHistory(moved);
}

/** Re-export for callers that build the POD DTO (kept in one place). */
export type { ProofOfDelivery };

/**
 * A delivery, described for a jury — the one description, used two ways.
 *
 * A reported DELIVERY makes this the subject material; a reported COURIER or
 * CUSTOMER attaches it as context. Both go through here so the redaction rules
 * are applied in exactly one place: a second copy of "which fields are safe" is a
 * second copy that will disagree, and the field it disagrees about is a phone
 * number.
 *
 * Everything that leaves this module has been through `redaction.ts`. Read that
 * file first — it is the argument for what a stranger may see of a private
 * transaction between two people at two street addresses.
 */

import mongoose from 'mongoose';
import { Job, type IJob } from '../../../models/job.js';
import { Shipment, type IShipment } from '../../../models/shipment.js';
import { note, redactEndpoint } from './redaction.js';
import type { ModerationContextResource, ModerationResource } from './types.js';

/**
 * The job, projected to exactly what a snapshot needs.
 *
 * An explicit projection rather than the whole document, and the exclusions are
 * the point: `pickupCode`, `dropoffCode`, `pickupCodeHash`, `dropoffCodeHash` and
 * `payment.reference` are never even LOADED here. A `.select()` is a weaker
 * guarantee than not fetching, but it means an accidental spread of this object
 * cannot leak a delivery verification code, because the field is not on it.
 */
const JOB_PROJECTION =
  'jobNumber shipmentId senderOxyUserId courierOxyUserId type fulfillmentType status ' +
  'pickupSnapshot dropoffSnapshot parcelSnapshot statusHistory proofOfDelivery.note createdAt';

const SHIPMENT_PROJECTION = 'itemDescription photos type distanceM';

/**
 * The keys a delivery description is allowed to carry. THE list, not a sample.
 *
 * Asserted as an exact set by `delivery-context.test.ts`, which fails when a key
 * is ADDED as well as when one is removed — and added is the direction that
 * matters, because a leak arrives as a new field somebody passed through, never
 * as a missing one. A list of "must not contain X" assertions cannot catch a
 * field nobody thought to forbid; an exact comparison catches every field at
 * once, including the one that has not been invented yet.
 *
 * Optional keys are absent rather than null when they have no value, so the test
 * compares against the subset a fully-populated delivery produces.
 */
export const DELIVERY_FACT_KEYS = Object.freeze([
  'deliveryType',
  'status',
  'fulfillment',
  'itemDescription',
  'parcelSizeClass',
  'parcelWeightKg',
  'parcelPieces',
  'parcelFragile',
  'pickupArea',
  'dropoffArea',
  'distanceKm',
  'pickupNotes',
  'dropoffNotes',
  'deliveryNote',
  'photoCount',
  'courierAssigned',
] as const);

/** Metres per kilometre, and the rounding the jury sees. */
const METRES_PER_KM = 1_000;

/**
 * How far the parcel travelled, to the nearest kilometre.
 *
 * A DERIVED scalar, which is the only form geography may take here. Two precise
 * points identify two homes; one distance answers the questions a jury actually
 * has — "the courier claims the address was unreachable", "the customer says
 * they took a two-hour detour" — and identifies nothing, because a distance is
 * translation-invariant. Rounding to a whole kilometre removes the last of the
 * re-identification value while leaving the number useful.
 *
 * Absent when Moovo never computed one, which is normal for a job booked before
 * the distance was known.
 */
function distanceKm(shipment: SnapshotShipment | null): number | undefined {
  const metres = shipment?.distanceM;
  if (typeof metres !== 'number' || !Number.isFinite(metres) || metres < 0) return undefined;
  return Math.round(metres / METRES_PER_KM);
}

type SnapshotJob = Pick<
  IJob,
  | '_id'
  | 'jobNumber'
  | 'shipmentId'
  | 'senderOxyUserId'
  | 'courierOxyUserId'
  | 'type'
  | 'fulfillmentType'
  | 'status'
  | 'pickupSnapshot'
  | 'dropoffSnapshot'
  | 'parcelSnapshot'
  | 'statusHistory'
  | 'createdAt'
> & { proofOfDelivery?: { note?: string } };

type SnapshotShipment = Pick<
  IShipment,
  '_id' | 'itemDescription' | 'photos' | 'type' | 'distanceM'
>;

export async function loadSnapshotJob(jobId: string): Promise<SnapshotJob | null> {
  if (!mongoose.isValidObjectId(jobId)) return null;
  return await Job.findById(jobId).select(JOB_PROJECTION).lean<SnapshotJob | null>();
}

async function loadShipment(shipmentId: string | undefined): Promise<SnapshotShipment | null> {
  if (shipmentId === undefined || !mongoose.isValidObjectId(shipmentId)) return null;
  return await Shipment.findById(shipmentId)
    .select(SHIPMENT_PROJECTION)
    .lean<SnapshotShipment | null>();
}

/**
 * The facts of a delivery, as a bounded scalar bag.
 *
 * A `metadata` resource rather than prose because these ARE typed key/value
 * fields and a jury reads them as facts, not as something someone wrote. The
 * user-authored strings (`itemDescription`, the endpoint notes) are the only free
 * text, and they are what an allegation like "this parcel was a prohibited item"
 * is actually about.
 *
 * Well under the 50-key metadata cap, and every value is a scalar — the contract
 * refuses a nested structure here, which is the constraint that stops a whole Job
 * document being posted through this field.
 */
function deliveryFacts(job: SnapshotJob, shipment: SnapshotShipment | null): Record<string, string | number | boolean> {
  const pickup = redactEndpoint(job.pickupSnapshot);
  const dropoff = redactEndpoint(job.dropoffSnapshot);
  const itemDescription = note(shipment?.itemDescription);
  const proofNote = note(job.proofOfDelivery?.note);
  const distance = distanceKm(shipment);

  return {
    // What kind of delivery, and how it ended. A cancelled job and a delivered one
    // support very different readings of the same complaint.
    deliveryType: job.type,
    status: job.status,
    fulfillment: job.fulfillmentType,
    // The parcel, which is the substance of a prohibited-item allegation.
    ...(itemDescription === undefined ? {} : { itemDescription }),
    parcelSizeClass: job.parcelSnapshot.sizeClass,
    parcelWeightKg: job.parcelSnapshot.weightKg,
    parcelPieces: job.parcelSnapshot.pieces,
    ...(job.parcelSnapshot.fragile === undefined ? {} : { parcelFragile: job.parcelSnapshot.fragile }),
    // Coarse place labels only — city/region/country, never a street or a postcode.
    ...(pickup.locationLabel === undefined ? {} : { pickupArea: pickup.locationLabel }),
    ...(dropoff.locationLabel === undefined ? {} : { dropoffArea: dropoff.locationLabel }),
    // Geography as ONE derived scalar. Never two points — see `distanceKm`.
    ...(distance === undefined ? {} : { distanceKm: distance }),
    // The user's own instructions, which is material a jury may need to read.
    ...(pickup.notes === undefined ? {} : { pickupNotes: pickup.notes }),
    ...(dropoff.notes === undefined ? {} : { dropoffNotes: dropoff.notes }),
    ...(proofNote === undefined ? {} : { deliveryNote: proofNote }),
    /**
     * Declared, not attached. A shipment's photos are bare Oxy file ids — exactly
     * the shape `AssetRef` wants — but attaching them is a separate decision with
     * its own privacy weight (a photo of a parcel on a doorstep is a photo of a
     * doorstep), and it needs the digest to enter the snapshot hash. Saying the
     * count lets a jury answer `insufficient_context` for the right reason rather
     * than by accident. See `evidenceAttachmentsSupported` in EvidenceSnapshotService.
     */
    photoCount: shipment?.photos?.length ?? 0,
    /**
     * Whether the courier ever accepted. A complaint about a courier on a job no
     * courier was ever assigned to is a different — and usually mistaken — claim,
     * and a jury cannot see that from anything else here.
     */
    courierAssigned: job.courierOxyUserId !== undefined,
  };
}

/** The delivery as the SUBJECT's own material (a reported delivery). */
export async function buildDeliveryResource(
  job: SnapshotJob,
): Promise<ModerationResource> {
  const shipment = await loadShipment(job.shipmentId);
  return {
    type: 'metadata',
    data: deliveryFacts(job, shipment),
    ...(job.createdAt === undefined ? {} : { createdAt: new Date(job.createdAt) }),
  };
}

/**
 * The delivery as CONTEXT for a report about a person, or nothing.
 *
 * `role: 'context'` rather than `'evidence'`: the delivery is the setting the
 * allegation happened in, not proof of it. Calling it evidence would tell a jury
 * that Moovo believes it substantiates the claim, which Moovo has no basis to
 * assert and is not its job to.
 *
 * Returns `null` for an absent or unresolvable job id, which is ordinary — a
 * report can name no delivery at all, and a job deleted since the report is not
 * an error. The caller sends the profile alone.
 */
export async function buildDeliveryContext(
  jobId: string | undefined,
): Promise<ModerationContextResource | null> {
  if (jobId === undefined) return null;
  const job = await loadSnapshotJob(jobId);
  if (!job) return null;
  const resource = await buildDeliveryResource(job);
  return { ...resource, role: 'context' };
}

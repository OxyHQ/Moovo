/**
 * JobOffer model — one time-boxed dispatch offer of a job to a single candidate
 * courier during real-time (Glovo-style) dispatch.
 *
 * One doc per (job, candidate courier). Many offers can be live for one job at
 * once (a "wave"); the first courier to accept wins the job via an atomic CAS and
 * every SIBLING `offered` offer is flipped to `superseded`. Offers are time-boxed
 * by `expiresAt`: the maintenance sweep flips still-`offered` offers past their
 * expiry to `expired` and re-dispatches the job. A TTL index on `expiresAt`
 * (`expireAfterSeconds: 0`) is a bounded-growth BACKSTOP only — the sweep performs
 * the semantic `offered → expired` flip FIRST, so the TTL never silently reaps a
 * still-live offer (Mongo's TTL reaper runs at most once per minute and only
 * removes docs already past `expiresAt`). All ids are Strings (Oxy ids are always
 * Strings; cross-collection job/shipment ids are stored as Strings too). Mirrors
 * the `courier-profile.ts` / `job.ts` style: a `JOB_OFFER_STATUSES` tuple derived
 * alongside the shared-types union keeps the schema enum and the DTO in lockstep.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { JobOfferStatus } from '@moovo/shared-types';

const JOB_OFFER_STATUSES: readonly JobOfferStatus[] = [
  'offered',
  'accepted',
  'declined',
  'expired',
  'superseded',
];

/** Offer statuses that are NOT terminal — a courier could still win these. */
export const NON_TERMINAL_OFFER_STATUSES: readonly JobOfferStatus[] = ['offered'];

export interface IJobOffer {
  _id: mongoose.Types.ObjectId;
  jobId: string;
  shipmentId: string;
  courierOxyUserId: string;
  companyId?: string;
  status: JobOfferStatus;
  offeredAt: Date;
  expiresAt: Date;
  rank: number;
  distanceM: number;
  createdAt: Date;
  updatedAt: Date;
}

const JobOfferSchema = new Schema<IJobOffer>(
  {
    jobId: { type: String, required: true },
    shipmentId: { type: String, required: true },
    courierOxyUserId: { type: String, required: true },
    companyId: { type: String },
    status: { type: String, enum: JOB_OFFER_STATUSES as string[], default: 'offered' },
    offeredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    rank: { type: Number, required: true },
    distanceM: { type: Number, required: true },
  },
  { timestamps: true },
);

// Sweep + sibling-supersede query (all offers of a job in a given status).
JobOfferSchema.index({ jobId: 1, status: 1 });
// A courier's inbox of live offers + the dispatch exclusion query.
JobOfferSchema.index({ courierOxyUserId: 1, status: 1 });
// Bounded-growth TTL backstop: reap offers after they expire. The sweep flips
// still-`offered` offers to `expired` BEFORE this ever removes them.
JobOfferSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const JobOffer: Model<IJobOffer> =
  mongoose.models.JobOffer || mongoose.model<IJobOffer>('JobOffer', JobOfferSchema);

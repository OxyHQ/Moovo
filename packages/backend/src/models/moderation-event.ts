/**
 * ModerationEvent — every webhook delivery CrowdSource made, and what became of
 * it.
 *
 * Two jobs in one collection, and they are the same job:
 *
 * 1. **The dedupe claim.** `_id` is the webhook event id and the index on it is
 *    unique, so INSERTING the row IS the claim — a concurrent redelivery gets a
 *    duplicate-key error, which is the answer "somebody else has this event"
 *    rather than a failure to work around. Moovo runs several ECS tasks behind one
 *    ALB, so the SDK's in-process default store would dedupe only the instance
 *    that happened to receive both copies.
 * 2. **The audit row.** "Did CrowdSource tell us about this case, and when" is the
 *    first question asked when a report looks stuck, and the answer has to exist
 *    somewhere. Events carrying nothing to enforce (`case.created`, `case.closed`,
 *    and any type a newer CrowdSource introduces) are recorded as `ignored`
 *    rather than dropped.
 */

import mongoose, { Schema, Model } from 'mongoose';

/** Comfortably longer than any sender-side retry schedule. */
export const MODERATION_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const MODERATION_EVENT_STATES = ['claimed', 'queued', 'ignored'] as const;

export interface IModerationEvent {
  _id: string;
  type?: string;
  caseId?: string;
  /** The event as delivered, stored whole and parsed by the worker that acts on it. */
  payload?: unknown;
  state: (typeof MODERATION_EVENT_STATES)[number];
  receivedAt: Date;
  queuedAt?: Date;
  expiresAt: Date;
  updatedAt?: Date;
}

const ModerationEventSchema = new Schema<IModerationEvent>(
  {
    _id: { type: String, required: true },
    type: { type: String },
    caseId: { type: String },
    payload: { type: Schema.Types.Mixed },
    state: {
      type: String,
      enum: MODERATION_EVENT_STATES as unknown as string[],
      default: 'claimed',
    },
    receivedAt: { type: Date, required: true },
    queuedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true }, _id: false },
);

ModerationEventSchema.index({ caseId: 1, receivedAt: -1 }, { sparse: true });
ModerationEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationEvent: Model<IModerationEvent> =
  mongoose.models.ModerationEvent ||
  mongoose.model<IModerationEvent>('ModerationEvent', ModerationEventSchema);

/**
 * ModerationOutbox — the durable promise that a piece of moderation work will
 * happen.
 *
 * The row IS the job. There is no second queue, no BullMQ mirror and no in-memory
 * list that could drift out of sync with it: a row exists exactly when work is
 * owed, and it is written in the SAME transaction as the domain write that owed
 * it. That coupling is the whole point of the collection — see
 * `enqueueModerationOutboxEvent`, which refuses to write outside a transaction.
 *
 * `_id` is a caller-supplied deterministic string rather than an ObjectId, so a
 * transaction retry or a webhook redelivery upserts the SAME row instead of
 * queueing the work twice.
 */

import mongoose, { Schema, Model } from 'mongoose';

/**
 * How long a processed row is kept.
 *
 * Long enough that "did this report ever go out, and when" is answerable during
 * an incident review; a TTL rather than forever because a processed row is an
 * audit trail, not state.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;
export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];

const MODERATION_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
] as const;

/**
 * The payload, by kind.
 *
 * `decision` is `unknown` deliberately: it is stored whole as delivered and
 * parsed against the published contract by the worker that acts on it. Validating
 * it at write time would mean an event shape this deployment does not recognise
 * yet is refused at the door and retried until it dead-letters, instead of being
 * kept until the code catches up.
 */
export interface ModerationOutboxPayload {
  reportId?: string;
  eventId?: string;
  caseId?: string;
  decision?: unknown;
}

export interface IModerationOutbox {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  status: (typeof MODERATION_OUTBOX_STATUSES)[number];
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  processedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationOutboxSchema = new Schema<IModerationOutbox>(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: MODERATION_OUTBOX_KINDS as unknown as string[], required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: MODERATION_OUTBOX_STATUSES as unknown as string[],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, required: true },
    leaseOwner: { type: String },
    leaseUntil: { type: Date },
    lastError: { type: String },
    processedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false },
);

// The claim query: due pending rows, and processing rows whose lease has expired.
ModerationOutboxSchema.index({ status: 1, availableAt: 1 });
ModerationOutboxSchema.index({ status: 1, leaseUntil: 1 });
// Mongo reclaims processed/dead rows on the retention window.
ModerationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationOutbox: Model<IModerationOutbox> =
  mongoose.models.ModerationOutbox ||
  mongoose.model<IModerationOutbox>('ModerationOutbox', ModerationOutboxSchema);

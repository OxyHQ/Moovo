/**
 * ModerationEnforcement — one row per thing Moovo did (or deliberately did not
 * do) about a decision.
 *
 * The unique compound index is the idempotency mechanism, and every part of the
 * key is load-bearing:
 *
 * - `decisionId` — the decision this came from.
 * - `revision` — **the part that is easy to drop and expensive to lose.** A
 *   correction or a successful appeal is a NEW revision of the same decision, and
 *   its `restore` must be a DIFFERENT action from the removal it supersedes.
 *   Leave `revision` out of the key and the restore collides with the earlier
 *   row, is treated as already applied, and an accepted appeal can never put
 *   anything back — with no error anywhere.
 * - `action` — one decision can legitimately produce several actions.
 *
 * Each action CLAIMS its row before acting and releases it if the effect throws,
 * so a crash mid-enforcement is retried rather than recorded as done.
 */

import mongoose, { Schema, Model } from 'mongoose';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  type ModerationEnforcementAction,
} from '@moovo/shared-types';

const MAX_REASON_LENGTH = 500;

export interface IModerationEnforcement {
  _id: mongoose.Types.ObjectId;
  decisionId: string;
  revision: number;
  action: ModerationEnforcementAction;
  caseId?: string;
  reportId?: string;
  /** What the action was carried out against — an Oxy user id or a job id. */
  targetType: 'courier' | 'customer' | 'delivery';
  targetId: string;
  /**
   * Whether the effect actually happened.
   *
   * `false` in `observe` mode, and also when there was genuinely nothing to do
   * (a `restore` for something never restricted). The reason distinguishes them,
   * which is how "we checked and there was nothing to undo" stays different from
   * "we never looked".
   */
  applied: boolean;
  reason: string;
  appliedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationEnforcementSchema = new Schema<IModerationEnforcement>(
  {
    decisionId: { type: String, required: true },
    revision: { type: Number, required: true },
    action: {
      type: String,
      enum: MODERATION_ENFORCEMENT_ACTIONS as unknown as string[],
      required: true,
    },
    caseId: { type: String },
    reportId: { type: String },
    targetType: { type: String, enum: ['courier', 'customer', 'delivery'], required: true },
    targetId: { type: String, required: true },
    applied: { type: Boolean, default: false },
    reason: { type: String, required: true, maxlength: MAX_REASON_LENGTH },
    appliedAt: { type: Date },
  },
  { timestamps: true },
);

// Appendix D: idempotent on decision + revision + action. See the header.
ModerationEnforcementSchema.index(
  { decisionId: 1, revision: 1, action: 1 },
  { unique: true },
);
// "What has been done to this courier / this delivery" — the operator's question.
ModerationEnforcementSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const ModerationEnforcement: Model<IModerationEnforcement> =
  mongoose.models.ModerationEnforcement ||
  mongoose.model<IModerationEnforcement>('ModerationEnforcement', ModerationEnforcementSchema);

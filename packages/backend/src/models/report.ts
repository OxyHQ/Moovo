/**
 * Report model — one user's claim about one object, and where that claim went.
 *
 * A report carries TWO status axes and they answer different questions:
 * `status` is what Moovo concluded (the axis a user-facing receipt reads), and
 * `localStatus` is where the report stands in the delivery pipeline. Collapsing
 * them loses one — a report can be `pending` on the first axis while being
 * `submitted` on the second, and "a jury has it" is not "Moovo decided".
 *
 * `reporter`, `reportedId` for a person, and every id here are Oxy user ids or
 * Mongo ids stored as Strings, matching the rest of the codebase (`job.senderOxyUserId`,
 * `review.authorOxyUserId`); no mongoose `ref` is used.
 */

import mongoose, { Schema, Model } from 'mongoose';
import {
  MODERATION_LOCAL_STATUSES,
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  type ModerationLocalStatus,
  type ReportCategory,
  type ReportStatus,
  type ReportedType,
} from '@moovo/shared-types';

/** Bounded so a reporter's free text cannot become an unbounded document. */
const MAX_DETAILS_LENGTH = 2_000;
/** Bounded, and read by an operator rather than a user. */
const MAX_REASON_LENGTH = 300;
const MAX_ERROR_LENGTH = 2_000;

export interface IReport {
  _id: mongoose.Types.ObjectId;
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  /**
   * The delivery this report is about, when the subject is a person.
   *
   * Only ever set after the intake service has confirmed the reporter was a party
   * to that job — see `ReportIntakeService`. An unchecked value here would travel
   * into a case as context and expose a stranger's delivery to a jury.
   */
  contextJobId?: string;
  categories: ReportCategory[];
  details?: string;
  status: ReportStatus;
  localStatus: ModerationLocalStatus;
  /** Why the report is going nowhere, when it is going nowhere. */
  localStatusReason?: string;
  lastDeliveryError?: string;
  /** SHA-256 of the exact material reviewed, so a decision about an older version stays identifiable. */
  contentSnapshotHash?: string;
  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  /**
   * The revision of the last decision written to this report.
   *
   * Present so a late or retried delivery of an EARLIER revision cannot overwrite
   * a later one — see the guarded update in `moderation-decision.worker.ts`.
   * Absent until the first decision arrives.
   */
  decisionRevision?: number;
  submittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    reporter: { type: String, required: true },
    reportedType: { type: String, enum: REPORTED_TYPES as unknown as string[], required: true },
    reportedId: { type: String, required: true },
    contextJobId: { type: String },
    categories: {
      type: [String],
      enum: REPORT_CATEGORIES as unknown as string[],
      required: true,
    },
    details: { type: String, maxlength: MAX_DETAILS_LENGTH },
    status: {
      type: String,
      enum: REPORT_STATUSES as unknown as string[],
      default: 'pending',
    },
    localStatus: {
      type: String,
      enum: MODERATION_LOCAL_STATUSES as unknown as string[],
      default: 'received',
    },
    localStatusReason: { type: String, maxlength: MAX_REASON_LENGTH },
    lastDeliveryError: { type: String, maxlength: MAX_ERROR_LENGTH },
    contentSnapshotHash: { type: String },
    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String },
    crowdSourceMerged: { type: Boolean },
    submittedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One report per reporter per object.
 *
 * A unique index rather than a service-layer check: two concurrent submissions
 * from a double-tapped button race a `findOne` and both pass it, and the second
 * report would open a second case for one incident.
 */
ReportSchema.index({ reporter: 1, reportedType: 1, reportedId: 1 }, { unique: true });
// The delivery sweep: find reports still owed an attempt.
ReportSchema.index({ localStatus: 1, createdAt: -1 });
// Reading a case back to the report that opened it.
ReportSchema.index({ crowdSourceCaseId: 1 }, { sparse: true });

export const Report: Model<IReport> =
  mongoose.models.Report || mongoose.model<IReport>('Report', ReportSchema);

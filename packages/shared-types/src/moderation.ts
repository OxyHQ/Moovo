/**
 * Moderation DTOs — the report surface and the two status axes a report carries.
 *
 * Moovo reports go to CrowdSource, which decides them with a randomly drawn jury
 * and sends signed decisions back. CrowdSource owns cases, reviews and decisions;
 * Oxy Trust owns reputation; Moovo owns only its own enforcement actions. Moovo
 * never computes reputation and never calls Oxy Trust.
 */

/**
 * What a Moovo user can report.
 *
 * Two groups, and the difference between them is DELIVERY, not admission — see
 * `services/moderation/subjects/registry.ts`. A type with a subject provider is
 * sent for community review; a type without one is stored locally and never
 * leaves. Both are accepted by `POST /reports`.
 *
 * The courier/transport nouns (`courier`, `customer`, `delivery`) are the live
 * domain and are delivered. The marketplace nouns (`listing`, `store`, `review`)
 * are inherited scaffolding from the Mercaria fork that Moovo is removing, so
 * they are accepted and recorded but deliberately have no provider.
 */
export const REPORTED_TYPES = [
  'courier',
  'customer',
  'delivery',
  'listing',
  'store',
  'review',
] as const;
export type ReportedType = (typeof REPORTED_TYPES)[number];

/**
 * What a reporter picked in the Moovo UI.
 *
 * These are Moovo's own words for its own domain, translated into CrowdSource's
 * universal taxonomy in `report-taxonomy.ts`. They are ALLEGATIONS — what is
 * claimed, never what is true.
 */
export const REPORT_CATEGORIES = [
  'prohibited_item',
  'unsafe_conduct',
  'harassment',
  'discrimination',
  'threat',
  'theft_or_damage',
  'impersonation',
  'privacy',
  'service_failure',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * The legacy status axis: where the report stands as a piece of work.
 *
 * Kept separate from {@link ModerationLocalStatus} because they answer different
 * questions and collapsing them loses one. This one says what Moovo concluded;
 * the other says where the report is in the delivery pipeline.
 */
export const REPORT_STATUSES = ['pending', 'reviewed', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * Where the report is in Moovo's own pipeline.
 *
 * `received` is the local-only terminal state — a type with no subject provider.
 * It is NOT a failure and must never be re-queued: the reconciliation sweep counts
 * these and deliberately excludes them from its retry filter.
 */
export const MODERATION_LOCAL_STATUSES = [
  'received',
  'queued',
  'submitted',
  'delivery_failed',
  'closed',
] as const;
export type ModerationLocalStatus = (typeof MODERATION_LOCAL_STATUSES)[number];

/**
 * What Moovo can actually do about a decision, reversibly.
 *
 * Deliberately small. Moovo holds three levers and no more, so a recommendation
 * it cannot carry out becomes `manual_review` and is RECORDED rather than
 * dropped — a recommendation Moovo declined must not look like one it never
 * received.
 */
export const MODERATION_ENFORCEMENT_ACTIONS = [
  'none',
  'suspend_courier',
  'restrict_delivery',
  'restore',
  'manual_review',
] as const;
export type ModerationEnforcementAction = (typeof MODERATION_ENFORCEMENT_ACTIONS)[number];

/** How much of a decision Moovo is allowed to carry out. */
export const MODERATION_ENFORCEMENT_MODES = ['observe', 'manual', 'automatic'] as const;
export type ModerationEnforcementMode = (typeof MODERATION_ENFORCEMENT_MODES)[number];

/** `POST /reports` request body. */
export interface CreateReportInput {
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
  /**
   * The delivery this report is ABOUT, when the subject is a person.
   *
   * A courier-conduct report names an account but is really about an encounter,
   * and a jury cannot answer "was this courier abusive" from a profile alone. The
   * job travels as context — but only after the server has checked the reporter
   * was a party to it, because an unchecked id here would let anyone attach a
   * stranger's delivery to a case.
   */
  contextJobId?: string;
}

/** `POST /reports` response. A 201 means STORED, never "CrowdSource accepted it". */
export interface ReportReceiptDTO {
  id: string;
  reportedType: ReportedType;
  reportedId: string;
  status: ReportStatus;
  localStatus: ModerationLocalStatus;
  /** Why it is going nowhere, when it is going nowhere. */
  localStatusReason?: string;
  createdAt: string;
}

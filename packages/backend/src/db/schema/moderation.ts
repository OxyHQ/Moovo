/**
 * Abuse reports, the CrowdSource delivery pipeline, and what Moovo did about
 * a decision.
 *
 * ## Two tables here do NOT generate their own primary key
 *
 * `moderation_events.id` IS the webhook event id, and inserting the row IS the
 * dedupe claim — a concurrent redelivery gets a duplicate-key error, which is
 * the answer "somebody else has this event" rather than a failure to work
 * around. `moderation_outboxes.id` is a caller-supplied deterministic id so a
 * transaction retry upserts the SAME row instead of queueing the work twice.
 *
 * Both therefore use a bare `text().primaryKey()` rather than `generatedId()`.
 * Giving either a generated default would silently break the property the
 * table exists for: two deliveries of one event would become two rows, and
 * nothing would look wrong.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { closedSet, closedSetArray, foreignServiceId } from './columns';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  MODERATION_ENFORCEMENT_TARGET_TYPES,
  MODERATION_EVENT_STATES,
  MODERATION_LOCAL_STATUSES,
  MODERATION_OUTBOX_KINDS,
  MODERATION_OUTBOX_STATUSES,
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from './valueSets';
import { jobs } from './transport';

/** Bounds carried over from the source's `maxlength`. */
const MAX_DETAILS_LENGTH = 2_000;
const MAX_REASON_LENGTH = 300;
const MAX_ERROR_LENGTH = 2_000;
const MAX_ENFORCEMENT_REASON_LENGTH = 500;

/**
 * One user's claim about one object, and where that claim went.
 *
 * Two status axes, deliberately: `status` is what Moovo concluded and
 * `localStatus` is where the report stands in the delivery pipeline.
 * Collapsing them loses one — "a jury has it" is not "Moovo decided".
 */
export const reports = pgTable(
  'reports',
  {
    id: generatedId(),
    reporter: foreignServiceId().notNull(),
    reportedType: text().notNull(),
    /** Polymorphic by `reportedType` — an Oxy user id, a job id, a listing id. */
    reportedId: foreignServiceId().notNull(),
    /**
     * The delivery this report is about, when the subject is a person. Only
     * ever set after intake has confirmed the reporter was a party to it.
     */
    contextJobId: text().references(() => jobs.id, { onDelete: 'set null' }),
    categories: text().array().notNull(),
    details: text(),
    status: text().notNull().default('pending'),
    localStatus: text().notNull().default('received'),
    localStatusReason: text(),
    lastDeliveryError: text(),
    /** SHA-256 of the exact material reviewed. */
    contentSnapshotHash: text(),
    crowdSourceReportId: foreignServiceId(),
    crowdSourceCaseId: foreignServiceId(),
    crowdSourceMerged: boolean(),
    /**
     * The revision of the last decision written to this report — and a column
     * the SOURCE never actually had.
     *
     * `IReport` declares it and `moderation-decision.worker.ts` writes it with
     * `$set`, but `ReportSchema` declares no such path, so Mongoose's strict
     * mode strips it from every update. The guard it exists for — refusing a
     * late delivery of an EARLIER revision — therefore never held: the
     * `{decisionRevision: {$lt: n}}` arm of that filter could never match,
     * because the field was never stored. Declaring it here is what makes the
     * guard real; nothing in the Mongo model is touched.
     */
    decisionRevision: integer(),
    submittedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('reports_reported_type_check', table.reportedType, REPORTED_TYPES),
    closedSet('reports_status_check', table.status, REPORT_STATUSES),
    closedSet('reports_local_status_check', table.localStatus, MODERATION_LOCAL_STATUSES),
    closedSetArray('reports_categories_check', table.categories, REPORT_CATEGORIES),
    /** A reporter's free text must not become an unbounded row. */
    check(
      'reports_details_length_check',
      sql`${table.details} is null or char_length(${table.details}) <= ${sql.raw(String(MAX_DETAILS_LENGTH))}`,
    ),
    check(
      'reports_local_status_reason_length_check',
      sql`${table.localStatusReason} is null or char_length(${table.localStatusReason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    check(
      'reports_last_delivery_error_length_check',
      sql`${table.lastDeliveryError} is null or char_length(${table.lastDeliveryError}) <= ${sql.raw(String(MAX_ERROR_LENGTH))}`,
    ),
    /**
     * One report per reporter per object — a constraint rather than a
     * service-layer check, because two concurrent submissions from a
     * double-tapped button both pass a `findOne` and the second opens a second
     * case for one incident.
     */
    uniqueIndex('reports_reporter_target_key').on(
      table.reporter,
      table.reportedType,
      table.reportedId,
    ),
    index('reports_local_status_created_idx').on(table.localStatus, table.createdAt),
    index('reports_crowdsource_case_idx')
      .on(table.crowdSourceCaseId)
      .where(sql`${table.crowdSourceCaseId} is not null`),
  ],
);

/**
 * Every webhook delivery CrowdSource made, and what became of it.
 *
 * No `createdAt`: the source sets `{timestamps: {createdAt: false}}` and
 * carries `receivedAt` instead, which is the delivery's own time rather than
 * the row's.
 */
export const moderationEvents = pgTable(
  'moderation_events',
  {
    /** The webhook event id. Inserting the row IS the dedupe claim. */
    id: text().primaryKey(),
    type: text(),
    caseId: foreignServiceId(),
    /** Stored whole as delivered, parsed by the worker that acts on it. */
    payload: jsonb(),
    state: text().notNull().default('claimed'),
    receivedAt: timestamptz().notNull(),
    queuedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('moderation_events_state_check', table.state, MODERATION_EVENT_STATES),
    index('moderation_events_case_received_idx')
      .on(table.caseId, table.receivedAt)
      .where(sql`${table.caseId} is not null`),
    /** Supports the expiry sweep's predicate — see `db/expiry.ts`. */
    index('moderation_events_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * The durable promise that a piece of moderation work will happen.
 *
 * The row IS the job: it is written in the SAME transaction as the domain
 * write that owed it, which is why `enqueueModerationOutboxEvent` refuses to
 * run outside one. See `db/transactionGuard.ts` for how that refusal survives
 * the port — a type alone cannot express it, because the root handle and a
 * transaction share one type.
 */
export const moderationOutboxes = pgTable(
  'moderation_outboxes',
  {
    /** Caller-supplied and deterministic, so a retry converges on one row. */
    id: text().primaryKey(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('moderation_outboxes_kind_check', table.kind, MODERATION_OUTBOX_KINDS),
    closedSet('moderation_outboxes_status_check', table.status, MODERATION_OUTBOX_STATUSES),
    /** The claim query: due pending rows, and rows whose lease has expired. */
    index('moderation_outboxes_status_available_idx').on(table.status, table.availableAt),
    index('moderation_outboxes_status_lease_idx').on(table.status, table.leaseUntil),
    /** Supports the expiry sweep's predicate — see `db/expiry.ts`. */
    index('moderation_outboxes_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * One row per thing Moovo did, or deliberately did not do, about a decision.
 *
 * Every part of the unique key is load-bearing, and `revision` is the part
 * that is easy to drop and expensive to lose: a correction or a successful
 * appeal is a NEW revision of the same decision, and its `restore` must be a
 * DIFFERENT action from the removal it supersedes. Leave `revision` out and
 * the restore collides with the earlier row, is treated as already applied,
 * and an accepted appeal can never put anything back — with no error anywhere.
 */
export const moderationEnforcements = pgTable(
  'moderation_enforcements',
  {
    id: generatedId(),
    /** CrowdSource's decision id. */
    decisionId: foreignServiceId().notNull(),
    revision: integer().notNull(),
    action: text().notNull(),
    caseId: foreignServiceId(),
    reportId: text().references(() => reports.id, { onDelete: 'set null' }),
    /** Polymorphic by `targetType` — an Oxy user id or a job id. */
    targetType: text().notNull(),
    targetId: foreignServiceId().notNull(),
    /**
     * Whether the effect actually happened — `false` in `observe` mode, and
     * also when there was genuinely nothing to do. The reason distinguishes
     * them, which is how "we checked and there was nothing to undo" stays
     * different from "we never looked".
     */
    applied: boolean().notNull().default(false),
    reason: text().notNull(),
    appliedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('moderation_enforcements_action_check', table.action, MODERATION_ENFORCEMENT_ACTIONS),
    closedSet(
      'moderation_enforcements_target_type_check',
      table.targetType,
      MODERATION_ENFORCEMENT_TARGET_TYPES,
    ),
    check(
      'moderation_enforcements_reason_length_check',
      sql`char_length(${table.reason}) <= ${sql.raw(String(MAX_ENFORCEMENT_REASON_LENGTH))}`,
    ),
    uniqueIndex('moderation_enforcements_decision_revision_action_key').on(
      table.decisionId,
      table.revision,
      table.action,
    ),
    index('moderation_enforcements_target_created_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

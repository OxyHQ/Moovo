/**
 * Moovo's half of Oxy Files (oxy ADR 0043): which Moovo rows use which Oxy
 * files, kept in step with Oxy, and what Moovo did when Oxy said a file was
 * taken down. Read `docs/oxy-files.md` before changing anything here.
 */

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { closedSet, foreignServiceId } from './columns';
import {
  FILE_REFERENCE_ENTITY_TYPES,
  FILE_REFERENCE_FIELDS,
  FILE_TAKEDOWN_ACTIONS,
  OXY_FILE_EVENT_TYPES,
} from './valueSets';

/**
 * The reference OUTBOX: one row per (entity, file) whose use CHANGED and has
 * not been told to Oxy yet.
 *
 * Written ONLY by the `*_file_references` triggers (migration 0011), in the
 * transaction of the write that changed the row — so a crash can never leave a
 * use Oxy was not told about, whichever code path wrote it. The row says
 * "look again", not "add" or "remove": the worker re-derives whether the entity
 * uses the file NOW and tells Oxy that, so the order rows are processed in
 * never matters and a later change can never be undone by an earlier one.
 *
 * `generation` is bumped by every re-enqueue. The worker deletes the row only
 * if the generation it claimed is still the row's, so a write that lands while
 * Oxy is being told leaves the row pending rather than lost. A transaction
 * timestamp could not do this: `now()` is the transaction's START, so a write
 * that began earlier and committed later would look older than the claim.
 *
 * Rows are deleted when done, so the table holds only outstanding work.
 */
export const fileReferenceSyncs = pgTable(
  'file_reference_syncs',
  {
    entityType: text().notNull(),
    entityId: text().notNull(),
    /** An Oxy file id. Oxy owns files: no FK. */
    fileId: foreignServiceId().notNull(),
    generation: integer().notNull().default(1),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull().defaultNow(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'file_reference_syncs_pkey',
      columns: [table.entityType, table.entityId, table.fileId],
    }),
    closedSet(
      'file_reference_syncs_entity_type_check',
      table.entityType,
      FILE_REFERENCE_ENTITY_TYPES,
    ),
    index('file_reference_syncs_available_idx').on(table.availableAt),
    index('file_reference_syncs_file_idx').on(table.fileId),
  ],
);

/**
 * The nightly reconciliation schedule, one row per entity type (ADR 0043 D6).
 *
 * Also the report: what the last run did (`lastResult` is Oxy's
 * `{ added, removed, unchanged, refused, dryRun }`) or why it failed. Rows are
 * created by the dispatcher from `FILE_REFERENCE_ENTITY_TYPES`, so adding a
 * type schedules it without a data migration. The lease lets every API task
 * run the loop while exactly one reconciles a type at a time — Oxy refuses a
 * second open session for the same type anyway (409).
 */
export const fileReferenceReconciliations = pgTable(
  'file_reference_reconciliations',
  {
    entityType: text().primaryKey(),
    nextRunAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastStartedAt: timestamptz(),
    lastFinishedAt: timestamptz(),
    lastResult: jsonb(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet(
      'file_reference_reconciliations_entity_type_check',
      table.entityType,
      FILE_REFERENCE_ENTITY_TYPES,
    ),
  ],
);

/**
 * One row per file event Oxy delivered and Moovo accepted: the dedupe claim
 * (delivery is at least once, and `id` is the same for every redelivery) plus
 * the event as received.
 *
 * Swept at `expiresAt`, 60 days after receipt — twice Oxy's own 30-day
 * delivery horizon, past which no redelivery can arrive. What Moovo DID about
 * an event lives in `file_takedown_actions`, which is not swept; that is why
 * the action row carries the event id as a value rather than a foreign key.
 */
export const fileEventReceipts = pgTable(
  'file_event_receipts',
  {
    /** Oxy's event id. */
    eventId: text().primaryKey(),
    type: text().notNull(),
    /** An Oxy file id. Oxy owns files: no FK. */
    fileId: foreignServiceId().notNull(),
    occurredAt: timestamptz().notNull(),
    payload: jsonb().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('file_event_receipts_type_check', table.type, OXY_FILE_EVENT_TYPES),
    index('file_event_receipts_expires_idx').on(table.expiresAt),
  ],
);

/**
 * The audit trail of what file events did to Moovo rows: a file Oxy blocked or
 * deleted is cleared from every row that showed it, and put back if Oxy
 * unblocks it. Append-only, never swept — it is the record of a takedown.
 *
 * `revertsActionId` ties a `restored`/`restore_skipped` row to the `cleared`
 * row it answers, and the partial unique index makes answering one twice
 * unrepresentable (two deliveries of an unblock, or two unblocks).
 */
export const fileTakedownActions = pgTable(
  'file_takedown_actions',
  {
    id: generatedId(),
    /** Oxy's event id; a value, not a FK — receipts are swept, this is not. */
    eventId: text().notNull(),
    /** The event's type: only what a `file.blocked` cleared is ever restored. */
    eventType: text().notNull(),
    /** An Oxy file id. Oxy owns files: no FK. */
    fileId: foreignServiceId().notNull(),
    entityType: text().notNull(),
    /** Polymorphic by `entityType`. */
    entityId: text().notNull(),
    field: text().notNull(),
    action: text().notNull(),
    /** For an array column, where in the array the file was. */
    position: integer(),
    revertsActionId: text().references((): AnyPgColumn => fileTakedownActions.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet(
      'file_takedown_actions_entity_type_check',
      table.entityType,
      FILE_REFERENCE_ENTITY_TYPES,
    ),
    closedSet('file_takedown_actions_event_type_check', table.eventType, OXY_FILE_EVENT_TYPES),
    closedSet('file_takedown_actions_field_check', table.field, FILE_REFERENCE_FIELDS),
    closedSet('file_takedown_actions_action_check', table.action, FILE_TAKEDOWN_ACTIONS),
    index('file_takedown_actions_file_idx').on(table.fileId),
    uniqueIndex('file_takedown_actions_reverts_key')
      .on(table.revertsActionId)
      .where(sql`${table.revertsActionId} is not null`),
  ],
);

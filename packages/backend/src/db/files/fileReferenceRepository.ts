/**
 * Every statement against `file_reference_syncs` (the reference outbox) and
 * `file_reference_reconciliations` (the nightly schedule), plus the two reads
 * that ask the DATABASE which files a row uses.
 *
 * Nothing here decides which columns hold a file: that is
 * `moovo_entity_file_ids()` in migration 0011, called from SQL so the trigger
 * that enqueues, the worker that re-checks and the inventory that reconciles
 * cannot disagree. See `docs/oxy-files.md`.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { fileReferenceReconciliations, fileReferenceSyncs } from '../schema/files';
import { FILE_REFERENCE_ENTITY_TYPES } from '../schema/valueSets';

export type FileReferenceEntityType = (typeof FILE_REFERENCE_ENTITY_TYPES)[number];

/**
 * The table each entity type lives in. Exhaustive over the tuple, so a new
 * entity type does not compile until it names its table — and migration 0011's
 * `moovo_entity_file_ids()` RAISES for a type it was not taught, so the SQL half
 * cannot be forgotten silently either.
 */
export const FILE_REFERENCE_ENTITY_TABLES: Readonly<Record<FileReferenceEntityType, string>> = {
  category: 'categories',
  listing: 'listings',
  store: 'stores',
  courier_company: 'courier_companies',
  shipment: 'shipments',
  job: 'jobs',
  provider: 'providers',
  tracking_carrier: 'tracking_carriers',
  order_item: 'order_items',
};

export function isFileReferenceEntityType(value: string): value is FileReferenceEntityType {
  return (FILE_REFERENCE_ENTITY_TYPES as readonly string[]).includes(value);
}

function tableOf(entityType: FileReferenceEntityType) {
  return sql.identifier(FILE_REFERENCE_ENTITY_TABLES[entityType]);
}

// ── The outbox ──────────────────────────────────────────────────────────────

/** A claimed outbox row. */
export interface FileReferenceSync {
  entityType: FileReferenceEntityType;
  entityId: string;
  fileId: string;
  generation: number;
  attempts: number;
}

type SyncRow = typeof fileReferenceSyncs.$inferSelect;

function toSync(row: SyncRow): FileReferenceSync {
  return {
    entityType: row.entityType as FileReferenceEntityType,
    entityId: row.entityId,
    fileId: row.fileId,
    generation: row.generation,
    attempts: row.attempts,
  };
}

function rowKey(sync: Pick<FileReferenceSync, 'entityType' | 'entityId' | 'fileId'>) {
  return and(
    eq(fileReferenceSyncs.entityType, sync.entityType),
    eq(fileReferenceSyncs.entityId, sync.entityId),
    eq(fileReferenceSyncs.fileId, sync.fileId),
  );
}

/**
 * Claim up to `limit` due rows under a lease. Due: available, and not leased
 * by a live worker — an expired lease is reclaimable, so a dead task strands
 * nothing. `SKIP LOCKED` lets every API task drain at once without two of them
 * taking the same row, and steps over a row a writer is re-enqueueing right
 * now (its transaction holds the row lock until it commits).
 */
export async function claimFileReferenceSyncs(
  options: { leaseOwner: string; leaseMs: number; limit: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<FileReferenceSync[]> {
  const now = options.now ?? new Date();
  const due = and(
    lte(fileReferenceSyncs.availableAt, now),
    or(isNull(fileReferenceSyncs.leaseUntil), lte(fileReferenceSyncs.leaseUntil, now)),
  );
  const rows = await db
    .update(fileReferenceSyncs)
    .set({
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      attempts: sql`${fileReferenceSyncs.attempts} + 1`,
    })
    .where(
      sql`(${fileReferenceSyncs.entityType}, ${fileReferenceSyncs.entityId}, ${fileReferenceSyncs.fileId}) in (
        select ${fileReferenceSyncs.entityType}, ${fileReferenceSyncs.entityId}, ${fileReferenceSyncs.fileId}
        from ${fileReferenceSyncs}
        where ${due}
        order by ${fileReferenceSyncs.availableAt} asc
        for update skip locked
        limit ${options.limit}
      )`,
    )
    .returning();
  return rows.map(toSync);
}

/**
 * Done: delete the row — but only the GENERATION that was claimed. A write
 * that re-enqueued the same (entity, file) while Oxy was being told bumped the
 * generation, and that newer request must survive; the row is merely released
 * (its `availableAt` is already now). Returns whether the row was deleted.
 */
export async function completeFileReferenceSync(
  sync: FileReferenceSync,
  leaseOwner: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(fileReferenceSyncs)
    .where(
      and(
        rowKey(sync),
        eq(fileReferenceSyncs.generation, sync.generation),
        eq(fileReferenceSyncs.leaseOwner, leaseOwner),
      ),
    );
  if ((deleted.count ?? 0) === 1) return true;
  await db
    .update(fileReferenceSyncs)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(rowKey(sync), eq(fileReferenceSyncs.leaseOwner, leaseOwner)));
  return false;
}

/**
 * Not done: release the lease and retry at `retryAt`. A row re-enqueued
 * meanwhile keeps its own (immediate) `availableAt` — new information is worth
 * asking about at once, whatever the old attempt's backoff said.
 */
export async function failFileReferenceSync(
  sync: FileReferenceSync,
  leaseOwner: string,
  error: string,
  retryAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(fileReferenceSyncs)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      lastError: error.slice(0, 2_000),
      availableAt: sql`case when ${fileReferenceSyncs.generation} = ${sync.generation} then ${retryAt.toISOString()}::timestamptz else ${fileReferenceSyncs.availableAt} end`,
    })
    .where(and(rowKey(sync), eq(fileReferenceSyncs.leaseOwner, leaseOwner)));
}

/** Outstanding outbox rows naming `fileId` — uses Oxy may not hold yet. */
export async function listPendingSyncsForFile(
  fileId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ entityType: FileReferenceEntityType; entityId: string }[]> {
  const rows = await db
    .select({ entityType: fileReferenceSyncs.entityType, entityId: fileReferenceSyncs.entityId })
    .from(fileReferenceSyncs)
    .where(eq(fileReferenceSyncs.fileId, fileId));
  return rows.map((row) => ({
    entityType: row.entityType as FileReferenceEntityType,
    entityId: row.entityId,
  }));
}

// ── What a row uses, asked of the database ──────────────────────────────────

/** Whether the row `entityId` of `entityType` uses `fileId` right now. */
export async function entityUsesFile(
  sync: Pick<FileReferenceSync, 'entityType' | 'entityId' | 'fileId'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db.execute<{ uses: boolean }>(sql`
    select exists (
      select 1 from ${tableOf(sync.entityType)} t
      where t.id = ${sync.entityId}
        and ${sync.fileId} = any(moovo_entity_file_ids(${sync.entityType}, to_jsonb(t)))
    ) as uses
  `);
  return rows[0]?.uses === true;
}

/** One page of the inventory: entities after `afterId`, with the files each uses. */
export async function listEntityFilePage(
  entityType: FileReferenceEntityType,
  afterId: string | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ entityId: string; fileIds: string[] }[]> {
  const rows = await db.execute<{ id: string; file_ids: string[] }>(sql`
    select t.id, moovo_entity_file_ids(${entityType}, to_jsonb(t)) as file_ids
    from ${tableOf(entityType)} t
    where ${afterId === null ? sql`true` : sql`t.id > ${afterId}`}
    order by t.id
    limit ${limit}
  `);
  return rows.map((row) => ({ entityId: row.id, fileIds: row.file_ids }));
}

/**
 * Every `{ fileId, entityId }` Moovo uses for `entityType`, streamed in pages
 * of ENTITIES (keyset on `id`), never of pairs: a page boundary inside one
 * entity's files would skip the rest of them.
 */
export async function* streamEntityFileInventory(
  entityType: FileReferenceEntityType,
  pageSize = 500,
  db: DatabaseOrTransaction = getDb(),
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let afterId: string | null = null;
  for (;;) {
    const page = await listEntityFilePage(entityType, afterId, pageSize, db);
    for (const entity of page) {
      for (const fileId of entity.fileIds) yield { fileId, entityId: entity.entityId };
    }
    if (page.length < pageSize) return;
    afterId = page[page.length - 1]?.entityId ?? null;
  }
}

// ── The nightly reconciliation schedule ─────────────────────────────────────

/** Create a schedule row, due now, for every entity type that has none. */
export async function ensureReconciliationSchedule(
  entityTypes: readonly FileReferenceEntityType[],
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (entityTypes.length === 0) return;
  await db
    .insert(fileReferenceReconciliations)
    .values(entityTypes.map((entityType) => ({ entityType, nextRunAt: now })))
    .onConflictDoNothing({ target: fileReferenceReconciliations.entityType });
}

/** Claim the most overdue entity type under a lease, or nothing. */
export async function claimDueReconciliation(
  options: { leaseOwner: string; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<FileReferenceEntityType | null> {
  const now = options.now ?? new Date();
  const due = and(
    lte(fileReferenceReconciliations.nextRunAt, now),
    or(
      isNull(fileReferenceReconciliations.leaseUntil),
      lte(fileReferenceReconciliations.leaseUntil, now),
    ),
  );
  const [row] = await db
    .update(fileReferenceReconciliations)
    .set({
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      lastStartedAt: now,
    })
    .where(
      sql`${fileReferenceReconciliations.entityType} = (
        select ${fileReferenceReconciliations.entityType}
        from ${fileReferenceReconciliations}
        where ${due}
        order by ${fileReferenceReconciliations.nextRunAt} asc
        for update skip locked
        limit 1
      )`,
    )
    .returning({ entityType: fileReferenceReconciliations.entityType });
  return row ? (row.entityType as FileReferenceEntityType) : null;
}

/** Record the outcome and the next run; only the lease holder may. */
export async function finishReconciliation(
  input: {
    entityType: FileReferenceEntityType;
    leaseOwner: string;
    nextRunAt: Date;
    result?: Record<string, unknown>;
    error?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(fileReferenceReconciliations)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: input.nextRunAt,
      lastFinishedAt: now,
      ...(input.result === undefined ? {} : { lastResult: input.result, lastError: null }),
      ...(input.error === undefined ? {} : { lastError: input.error.slice(0, 2_000) }),
    })
    .where(
      and(
        eq(fileReferenceReconciliations.entityType, input.entityType),
        eq(fileReferenceReconciliations.leaseOwner, input.leaseOwner),
      ),
    );
  return (updated.count ?? 0) === 1;
}

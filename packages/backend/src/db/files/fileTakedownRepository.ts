/**
 * What a file event does to Moovo rows, and the record of it.
 *
 * `file_event_receipts` is the dedupe claim (Oxy delivers at least once);
 * `file_takedown_actions` is the audit trail of every column a takedown
 * cleared and every one an unblock put back. Every write here runs in the
 * caller's transaction with the receipt, so an event is applied exactly once
 * or not at all.
 *
 * Clearing a file from a row is an ordinary UPDATE of that row, so the row's
 * `*_file_references` trigger enqueues the reference removal like any other
 * write — nothing here talks to Oxy.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import type { FileEvent } from '@oxy.so/core/server';
import { requireTransaction } from '../transactionGuard';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { fileEventReceipts, fileTakedownActions } from '../schema/files';
import { categories, listings } from '../schema/catalog';
import { orderItems } from '../schema/commerce';
import { courierCompanies } from '../schema/fleet';
import { stores } from '../schema/stores';
import { trackingCarriers } from '../schema/tracking';
import { jobs, providers, shipments } from '../schema/transport';
import type { FILE_REFERENCE_FIELDS, FILE_TAKEDOWN_ACTIONS } from '../schema/valueSets';
import type { FileReferenceEntityType } from './fileReferenceRepository';

export type FileReferenceField = (typeof FILE_REFERENCE_FIELDS)[number];
export type FileTakedownAction = (typeof FILE_TAKEDOWN_ACTIONS)[number];

/** How long a receipt is kept: twice Oxy's 30-day delivery horizon. */
export const FILE_EVENT_RECEIPT_RETENTION_SECONDS = 60 * 24 * 60 * 60;

/** One column of a row that can hold a file. */
interface Slot {
  field: FileReferenceField;
  column: PgColumn;
  /** The drizzle property name, for `.set()`. */
  key: string;
  /** `[{ fileId, position, … }]` rather than one id. */
  array: boolean;
}

interface EntitySlots {
  table: PgTable;
  id: PgColumn;
  slots: readonly Slot[];
}

const scalar = (field: FileReferenceField, column: PgColumn, key: string): Slot => ({
  field,
  column,
  key,
  array: false,
});
const list = (field: FileReferenceField, column: PgColumn, key: string): Slot => ({
  field,
  column,
  key,
  array: true,
});

/**
 * The columns a takedown may write, per entity type. The SAME columns
 * `moovo_entity_file_ids()` reads (migration 0011); `file-takedown.realdb.test.ts`
 * holds the two equal by clearing a file from every slot and asking the SQL
 * function what is left.
 */
export const ENTITY_FILE_SLOTS: Readonly<Record<FileReferenceEntityType, EntitySlots>> = {
  category: {
    table: categories,
    id: categories.id,
    slots: [scalar('image_file_id', categories.imageFileId, 'imageFileId')],
  },
  listing: {
    table: listings,
    id: listings.id,
    slots: [list('images', listings.images, 'images')],
  },
  store: {
    table: stores,
    id: stores.id,
    slots: [
      scalar('logo_file_id', stores.logoFileId, 'logoFileId'),
      scalar('cover_file_id', stores.coverFileId, 'coverFileId'),
    ],
  },
  courier_company: {
    table: courierCompanies,
    id: courierCompanies.id,
    slots: [scalar('cover_file_id', courierCompanies.coverFileId, 'coverFileId')],
  },
  shipment: {
    table: shipments,
    id: shipments.id,
    slots: [list('photos', shipments.photos, 'photos')],
  },
  job: {
    table: jobs,
    id: jobs.id,
    slots: [
      scalar('pod_photo_file_id', jobs.podPhotoFileId, 'podPhotoFileId'),
      scalar('pod_signature_file_id', jobs.podSignatureFileId, 'podSignatureFileId'),
    ],
  },
  provider: {
    table: providers,
    id: providers.id,
    slots: [scalar('logo_file_id', providers.logoFileId, 'logoFileId')],
  },
  tracking_carrier: {
    table: trackingCarriers,
    id: trackingCarriers.id,
    slots: [scalar('logo_file_id', trackingCarriers.logoFileId, 'logoFileId')],
  },
  order_item: {
    table: orderItems,
    id: orderItems.id,
    slots: [scalar('image_file_id', orderItems.imageFileId, 'imageFileId')],
  },
};

/** An element of an `images`/`photos` column. */
interface PositionedFile {
  fileId: string;
  position: number;
  [extra: string]: unknown;
}

function readPositioned(value: unknown): PositionedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is PositionedFile =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as PositionedFile).fileId === 'string' &&
        typeof (item as PositionedFile).position === 'number',
    )
    .sort((a, b) => a.position - b.position);
}

function renumber(items: PositionedFile[]): PositionedFile[] {
  return items.map((item, position) => ({ ...item, position }));
}

/**
 * Claim an event. `ON CONFLICT DO NOTHING RETURNING`: a redelivery answers
 * `false` without raising, so the caller's transaction stays usable.
 */
export async function claimFileEventReceipt(
  event: FileEvent,
  db: DatabaseOrTransaction,
  now: Date = new Date(),
): Promise<boolean> {
  const tx = requireTransaction(db, `claimFileEventReceipt('${event.id}')`);
  const rows = await tx
    .insert(fileEventReceipts)
    .values({
      eventId: event.id,
      type: event.type,
      fileId: event.file.id,
      occurredAt: new Date(event.occurredAt),
      payload: event as unknown as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + FILE_EVENT_RECEIPT_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: fileEventReceipts.eventId })
    .returning({ eventId: fileEventReceipts.eventId });
  return rows.length === 1;
}

/** One column a takedown changed. */
export interface FileTakedownChange {
  entityType: FileReferenceEntityType;
  entityId: string;
  field: FileReferenceField;
  action: FileTakedownAction;
  position?: number;
}

/**
 * Remove `fileId` from every slot of one row, recording each column changed.
 * The row is locked first, so a concurrent edit either lands before (and is
 * seen) or after (and keeps the file gone, or re-adds it deliberately).
 */
export async function clearFileFromEntity(
  input: {
    eventId: string;
    eventType: FileEvent['type'];
    fileId: string;
    entityType: FileReferenceEntityType;
    entityId: string;
  },
  db: Transaction,
): Promise<FileTakedownChange[]> {
  const entity = ENTITY_FILE_SLOTS[input.entityType];
  const [row] = (await db
    .select()
    .from(entity.table)
    .where(eq(entity.id, input.entityId))
    .for('update')) as Record<string, unknown>[];
  if (!row) return [];

  const changes: FileTakedownChange[] = [];
  for (const slot of entity.slots) {
    if (slot.array) {
      const items = readPositioned(row[slot.key]);
      const index = items.findIndex((item) => item.fileId === input.fileId);
      if (index === -1) continue;
      const kept = renumber(items.filter((item) => item.fileId !== input.fileId));
      await db
        .update(entity.table)
        .set({ [slot.key]: kept } as never)
        .where(eq(entity.id, input.entityId));
      changes.push({
        entityType: input.entityType,
        entityId: input.entityId,
        field: slot.field,
        action: 'cleared',
        position: index,
      });
    } else if (row[slot.key] === input.fileId) {
      await db
        .update(entity.table)
        .set({ [slot.key]: null } as never)
        .where(and(eq(entity.id, input.entityId), eq(slot.column, input.fileId)));
      changes.push({
        entityType: input.entityType,
        entityId: input.entityId,
        field: slot.field,
        action: 'cleared',
      });
    }
  }

  if (changes.length > 0) {
    await db.insert(fileTakedownActions).values(
      changes.map((change) => ({
        eventId: input.eventId,
        eventType: input.eventType,
        fileId: input.fileId,
        entityType: change.entityType,
        entityId: change.entityId,
        field: change.field,
        action: change.action,
        position: change.position ?? null,
      })),
    );
  }
  return changes;
}

/**
 * Rows of the small, Moovo-curated tables whose columns name `fileId`
 * directly: where an APPLICATION-owned file (category, provider and carrier
 * art) can be in use. Read when Oxy reports an event on a file Moovo owns, so
 * a use Oxy holds no reference for yet is still found.
 */
export async function findApplicationArtUsing(
  fileId: string,
  db: DatabaseOrTransaction,
): Promise<{ entityType: FileReferenceEntityType; entityId: string }[]> {
  const found: { entityType: FileReferenceEntityType; entityId: string }[] = [];
  for (const entityType of ['category', 'provider', 'tracking_carrier'] as const) {
    const entity = ENTITY_FILE_SLOTS[entityType];
    for (const slot of entity.slots) {
      const rows = (await db
        .select({ id: entity.id })
        .from(entity.table)
        .where(eq(slot.column, fileId))) as { id: string }[];
      for (const row of rows) found.push({ entityType, entityId: row.id });
    }
  }
  return found;
}

/**
 * Put `fileId` back wherever an earlier `file.blocked` cleared it and nothing
 * has answered that clearing yet. (What a `file.deleted` cleared stays
 * cleared: a deleted file never comes back.) A slot that is taken now (a new logo was chosen,
 * the gallery is full) or a row that is gone is NOT overwritten: that is
 * recorded as `restore_skipped`, and the owner can re-add the file.
 *
 * The cleared actions are locked, so two unblocks of the same file serialize
 * and the second finds nothing left to answer; the partial unique index on
 * `reverts_action_id` is the backstop.
 */
export async function restoreFileToEntities(
  input: { eventId: string; fileId: string; maxItemsPerArray: Readonly<Record<string, number>> },
  db: Transaction,
): Promise<FileTakedownChange[]> {
  const answered = alias(fileTakedownActions, 'answered');
  const cleared = await db
    .select({
      id: fileTakedownActions.id,
      entityType: fileTakedownActions.entityType,
      entityId: fileTakedownActions.entityId,
      field: fileTakedownActions.field,
      position: fileTakedownActions.position,
    })
    .from(fileTakedownActions)
    .leftJoin(answered, eq(answered.revertsActionId, fileTakedownActions.id))
    .where(
      and(
        eq(fileTakedownActions.fileId, input.fileId),
        eq(fileTakedownActions.action, 'cleared'),
        eq(fileTakedownActions.eventType, 'file.blocked'),
        isNull(answered.id),
      ),
    )
    .orderBy(fileTakedownActions.createdAt)
    .for('update', { of: fileTakedownActions });

  const changes: FileTakedownChange[] = [];
  for (const action of cleared) {
    const entityType = action.entityType as FileReferenceEntityType;
    const field = action.field as FileReferenceField;
    const entity = ENTITY_FILE_SLOTS[entityType];
    const slot = entity.slots.find((candidate) => candidate.field === field);
    const restored = slot
      ? await restoreSlot(db, entity, slot, action.entityId, input.fileId, {
          position: action.position,
          max: input.maxItemsPerArray[field],
        })
      : false;
    const change: FileTakedownChange = {
      entityType,
      entityId: action.entityId,
      field,
      action: restored ? 'restored' : 'restore_skipped',
      ...(action.position === null ? {} : { position: action.position }),
    };
    changes.push(change);
    await db.insert(fileTakedownActions).values({
      eventId: input.eventId,
      eventType: 'file.unblocked',
      fileId: input.fileId,
      entityType,
      entityId: action.entityId,
      field,
      action: change.action,
      position: action.position,
      revertsActionId: action.id,
    });
  }
  return changes;
}

async function restoreSlot(
  db: Transaction,
  entity: EntitySlots,
  slot: Slot,
  entityId: string,
  fileId: string,
  options: { position: number | null; max: number | undefined },
): Promise<boolean> {
  const [row] = (await db
    .select()
    .from(entity.table)
    .where(eq(entity.id, entityId))
    .for('update')) as Record<string, unknown>[];
  if (!row) return false;

  if (!slot.array) {
    if (row[slot.key] !== null && row[slot.key] !== undefined) return false;
    await db
      .update(entity.table)
      .set({ [slot.key]: fileId } as never)
      .where(and(eq(entity.id, entityId), sql`${slot.column} is null`));
    return true;
  }

  const items = readPositioned(row[slot.key]);
  if (items.some((item) => item.fileId === fileId)) return false;
  if (options.max !== undefined && items.length >= options.max) return false;
  const at = Math.min(Math.max(options.position ?? items.length, 0), items.length);
  const next = renumber([...items.slice(0, at), { fileId, position: at }, ...items.slice(at)]);
  await db
    .update(entity.table)
    .set({ [slot.key]: next } as never)
    .where(eq(entity.id, entityId));
  return true;
}

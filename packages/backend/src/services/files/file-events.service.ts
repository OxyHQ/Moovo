/**
 * What Moovo does when Oxy says something happened to a file it uses
 * (oxy ADR 0043 D9, D10).
 *
 * - `file.blocked` (a rights or privacy claim was actioned) and `file.deleted`
 *   (the owner deleted it, or the owning application went): the file is
 *   CLEARED from every Moovo row that shows it, and each cleared column is
 *   recorded in `file_takedown_actions`. Oxy no longer serves the bytes, so
 *   keeping the id would only render a broken image — and for a takedown,
 *   keep pointing at content somebody established a claim against.
 * - `file.lost` (the bytes are gone for good, ADR 0043 D13): cleared exactly as
 *   `file.deleted` is, since the file is never served again. Nothing restores it.
 * - `file.unblocked` (a counter-notice succeeded): what the block cleared is
 *   put back where it was, unless the slot has been reused since.
 * - `file.trashed`, `file.restored`, `file.visibility_changed`: recorded and
 *   left alone. Trash is the owner's own reversible choice — Oxy stops serving
 *   the file and a restore brings it back with nothing for Moovo to undo.
 *
 * Exactly once: the receipt claim and every change commit in ONE transaction,
 * so a redelivery finds the receipt and changes nothing, and a crash leaves
 * neither. Clearing a column is an ordinary row write, so its trigger enqueues
 * the reference removal; nothing here calls Oxy.
 */

import type { FileEvent } from '@oxy.so/core/server';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { log } from '../../lib/logger.js';
import {
  isFileReferenceEntityType,
  listPendingSyncsForFile,
  type FileReferenceEntityType,
} from '../../db/files/fileReferenceRepository.js';
import {
  claimFileEventReceipt,
  clearFileFromEntity,
  findApplicationArtUsing,
  restoreFileToEntities,
  type FileTakedownChange,
} from '../../db/files/fileTakedownRepository.js';

export interface FileEventOutcome {
  /** A redelivery of an event already applied. */
  duplicate: boolean;
  changes: FileTakedownChange[];
}

const CLEARING_EVENTS: ReadonlySet<FileEvent['type']> = new Set([
  'file.blocked',
  'file.deleted',
  'file.lost',
]);

export async function handleFileEvent(event: FileEvent): Promise<FileEventOutcome> {
  const outcome = await getDb().transaction(async (tx): Promise<FileEventOutcome> => {
    if (!(await claimFileEventReceipt(event, tx))) return { duplicate: true, changes: [] };

    if (CLEARING_EVENTS.has(event.type)) {
      // Where the file can be: every use Oxy holds a reference for (the event
      // lists Moovo's own), every use not told to Oxy yet (the outbox), and —
      // for a file Moovo itself owns — the curated art tables directly.
      const candidates = new Map<
        string,
        { entityType: FileReferenceEntityType; entityId: string }
      >();
      const add = (entityType: FileReferenceEntityType, entityId: string) =>
        candidates.set(`${entityType}|${entityId}`, { entityType, entityId });
      for (const reference of event.references) {
        if (isFileReferenceEntityType(reference.entityType)) {
          add(reference.entityType, reference.entityId);
        }
      }
      for (const pending of await listPendingSyncsForFile(event.file.id, tx)) {
        add(pending.entityType, pending.entityId);
      }
      if (event.file.ownerKind === 'application') {
        for (const art of await findApplicationArtUsing(event.file.id, tx)) {
          add(art.entityType, art.entityId);
        }
      }

      const changes: FileTakedownChange[] = [];
      for (const { entityType, entityId } of candidates.values()) {
        changes.push(
          ...(await clearFileFromEntity(
            {
              eventId: event.id,
              eventType: event.type,
              fileId: event.file.id,
              entityType,
              entityId,
            },
            tx,
          )),
        );
      }
      return { duplicate: false, changes };
    }

    if (event.type === 'file.unblocked') {
      const changes = await restoreFileToEntities(
        {
          eventId: event.id,
          fileId: event.file.id,
          maxItemsPerArray: {
            images: config.catalog.maxImagesPerListing,
            photos: config.files.maxPhotosPerShipment,
          },
        },
        tx,
      );
      return { duplicate: false, changes };
    }

    return { duplicate: false, changes: [] };
  });

  if (!outcome.duplicate) {
    log.general.info(
      {
        eventId: event.id,
        type: event.type,
        fileId: event.file.id,
        changes: outcome.changes.length,
      },
      '[Files] file event applied',
    );
  }
  return outcome;
}

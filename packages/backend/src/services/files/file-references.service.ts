/**
 * Telling Oxy which files Moovo uses (oxy ADR 0043 D4, D6).
 *
 * Two halves, both re-deriving the truth from Moovo's own rows rather than
 * trusting a remembered diff:
 *
 * - {@link runFileReferenceSyncBatch} drains `file_reference_syncs`, the outbox
 *   the `*_file_references` triggers write in every file-bearing write's own
 *   transaction. For each (entity, file) it asks the database whether the row
 *   uses the file NOW, and adds or removes Moovo's reference accordingly.
 * - {@link reconcileFileReferences} sends Oxy Moovo's whole inventory of one
 *   entity type; Oxy adds what is missing and removes what is stale. It is the
 *   safety net (a reference lost to a bug, rows written before migration 0011)
 *   and runs nightly from the dispatcher, or by hand with
 *   `scripts/reconcile-file-references.ts`.
 *
 * Neither ever deletes a FILE: removing Moovo's last reference to a person's
 * file only marks it "not in use" for them, and an application file nobody
 * references is collected by Oxy's own lifecycle sweep.
 */

import type {
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import { oxyClient } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import {
  claimFileReferenceSyncs,
  completeFileReferenceSync,
  entityUsesFile,
  failFileReferenceSync,
  streamEntityFileInventory,
  type FileReferenceEntityType,
  type FileReferenceSync,
} from '../../db/files/fileReferenceRepository.js';

/** The slice of `OxyServer.assets.references` this module uses. */
export interface FileReferenceClient {
  add(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  remove(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  reconcile(
    entityType: string,
    items: AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun?: boolean },
  ): Promise<ServiceReferenceReconcileResult>;
}

let client: () => FileReferenceClient = () => oxyClient.assets.references;

/** Test seam: replace Oxy's reference client. Pass nothing to restore it. */
export function setFileReferenceClientForTesting(next?: FileReferenceClient): void {
  client = next ? () => next : () => oxyClient.assets.references;
}

/** What one batch did. */
export interface FileReferenceSyncReport {
  claimed: number;
  added: number;
  removed: number;
  /** Adds Oxy refused: the file is gone, or Moovo may not reference it. */
  refused: number;
  /** Rows left for a later attempt (Oxy unreachable, or a row changed meanwhile). */
  retried: number;
}

/** Backoff for a failed attempt: 30 s doubling, capped. */
export function syncBackoffMs(attempts: number, maxMs: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(30_000 * 2 ** exponent, maxMs);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function send(
  op: 'add' | 'remove',
  rows: FileReferenceSync[],
  options: { leaseOwner: string; maxBackoffMs: number; now: () => Date },
  report: FileReferenceSyncReport,
): Promise<void> {
  if (rows.length === 0) return;
  const references = rows.map(({ fileId, entityType, entityId }) => ({
    fileId,
    entityType,
    entityId,
  }));

  let results: ServiceFileReferenceResult[];
  try {
    results = await client()[op](references);
  } catch (error: unknown) {
    const message = describe(error);
    log.general.warn(
      { err: error, op, count: rows.length },
      '[Files] reference write failed; will retry',
    );
    for (const row of rows) {
      const retryAt = new Date(
        options.now().getTime() + syncBackoffMs(row.attempts, options.maxBackoffMs),
      );
      await failFileReferenceSync(row, options.leaseOwner, message, retryAt);
      report.retried += 1;
    }
    return;
  }

  // Oxy answers in the order given; matched by key anyway, so a reordering
  // can never mark the wrong row done.
  const byKey = new Map(
    results.map((result) => [`${result.entityType}|${result.entityId}|${result.fileId}`, result]),
  );
  for (const row of rows) {
    const result = byKey.get(`${row.entityType}|${row.entityId}|${row.fileId}`);
    if (!result) {
      const retryAt = new Date(
        options.now().getTime() + syncBackoffMs(row.attempts, options.maxBackoffMs),
      );
      await failFileReferenceSync(row, options.leaseOwner, 'no result from Oxy', retryAt);
      report.retried += 1;
      continue;
    }
    if (op === 'add' && result.result === 'not_found') {
      // The file is gone, or it is not one Moovo may reference (another
      // application's private file, a person's private file they never
      // attached here). Asking again changes nothing; a later write to the row
      // or the nightly reconciliation asks afresh.
      log.general.warn(
        { fileId: row.fileId, entityType: row.entityType, entityId: row.entityId },
        '[Files] Oxy refused a reference',
      );
      report.refused += 1;
    } else if (op === 'add') {
      report.added += 1;
    } else {
      report.removed += 1;
    }
    const deleted = await completeFileReferenceSync(row, options.leaseOwner);
    if (!deleted) report.retried += 1;
  }
}

/**
 * Claim a batch of outbox rows and tell Oxy about each. Every row's verdict
 * is re-derived from the database after the claim, so a write that lands
 * meanwhile is either seen now or re-enqueued (and re-told) by its trigger.
 */
export async function runFileReferenceSyncBatch(options: {
  leaseOwner: string;
  leaseMs: number;
  limit: number;
  maxBackoffMs: number;
  now?: () => Date;
}): Promise<FileReferenceSyncReport> {
  const now = options.now ?? (() => new Date());
  const report: FileReferenceSyncReport = {
    claimed: 0,
    added: 0,
    removed: 0,
    refused: 0,
    retried: 0,
  };
  const claimed = await claimFileReferenceSyncs({
    leaseOwner: options.leaseOwner,
    leaseMs: options.leaseMs,
    limit: options.limit,
    now: now(),
  });
  report.claimed = claimed.length;
  if (claimed.length === 0) return report;

  const adds: FileReferenceSync[] = [];
  const removes: FileReferenceSync[] = [];
  for (const row of claimed) {
    (await entityUsesFile(row)) ? adds.push(row) : removes.push(row);
  }

  const context = { leaseOwner: options.leaseOwner, maxBackoffMs: options.maxBackoffMs, now };
  await send('add', adds, context, report);
  await send('remove', removes, context, report);
  return report;
}

/** Reconcile one entity type's references with Moovo's whole inventory. */
export async function reconcileFileReferences(
  entityType: FileReferenceEntityType,
  options: { dryRun: boolean },
): Promise<ServiceReferenceReconcileResult> {
  const result = await client().reconcile(entityType, streamEntityFileInventory(entityType), {
    dryRun: options.dryRun,
  });
  log.general.info(
    {
      entityType,
      dryRun: result.dryRun,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      refused: result.refused,
    },
    '[Files] references reconciled',
  );
  return result;
}

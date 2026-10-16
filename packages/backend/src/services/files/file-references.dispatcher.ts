/**
 * The loop that keeps Oxy told which files Moovo uses: drain the reference
 * outbox every few seconds, and reconcile each entity type once a night.
 *
 * Runs on EVERY task, not a leader: outbox rows and reconciliation slots are
 * claimed under Postgres leases with `SKIP LOCKED`, so tasks share the work
 * and a dead task's lease is simply reclaimed.
 *
 * Deliberately NOT a BullMQ repeatable job, for the reason the tracker gives:
 * those run only with Redis, and a reference loop that silently never runs
 * leaves Moovo's application files looking unused to Oxy, which collects them.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { canAuthenticateAsOxyService } from '../../ecosystemActivity.js';
import { FILE_REFERENCE_ENTITY_TYPES } from '../../db/schema/valueSets.js';
import {
  claimDueReconciliation,
  ensureReconciliationSchedule,
  finishReconciliation,
} from '../../db/files/fileReferenceRepository.js';
import { reconcileFileReferences, runFileReferenceSyncBatch } from './file-references.service.js';

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let stopping = false;
let scheduleEnsured = false;

const leaseOwner = `file-references-${process.pid}-${randomUUID().slice(0, 8)}`;

/** Batches drained per tick at most, so one tick cannot run unbounded. */
const MAX_BATCHES_PER_TICK = 20;

/** The next `hourUtc`:00 UTC strictly after `now`. */
export function nextNightlyRun(now: Date, hourUtc: number): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function drainOutbox(): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK && !stopping; batch += 1) {
    const report = await runFileReferenceSyncBatch({
      leaseOwner,
      leaseMs: config.files.syncLeaseMs,
      limit: config.files.syncBatchSize,
      maxBackoffMs: config.files.syncMaxBackoffMs,
    });
    if (report.claimed > 0) log.general.debug(report, '[Files] reference batch');
    if (report.claimed < config.files.syncBatchSize) return;
  }
}

/** Reconcile at most one due entity type. Exported for the realdb suite. */
export async function runDueReconciliation(now: Date = new Date()): Promise<string | null> {
  if (!scheduleEnsured) {
    await ensureReconciliationSchedule(FILE_REFERENCE_ENTITY_TYPES, now);
    scheduleEnsured = true;
  }
  const entityType = await claimDueReconciliation({
    leaseOwner,
    leaseMs: config.files.reconcileLeaseMs,
    now,
  });
  if (!entityType) return null;

  try {
    const result = await reconcileFileReferences(entityType, {
      dryRun: config.files.reconcileDryRun,
    });
    await finishReconciliation({
      entityType,
      leaseOwner,
      nextRunAt: nextNightlyRun(new Date(), config.files.reconcileHourUtc),
      result: { ...result },
    });
  } catch (error: unknown) {
    log.general.error({ err: error, entityType }, '[Files] reconciliation failed');
    await finishReconciliation({
      entityType,
      leaseOwner,
      nextRunAt: new Date(Date.now() + config.files.reconcileRetryMs),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return entityType;
}

async function tick(): Promise<void> {
  try {
    await drainOutbox();
    if (!stopping) await runDueReconciliation();
  } catch (error: unknown) {
    // The loop must survive anything a tick throws.
    log.general.error({ err: error }, '[Files] reference tick failed');
  }
}

export function startFileReferenceDispatcher(): void {
  if (timer !== null) return;
  if (!config.files.referencesEnabled) {
    log.general.info('[Files] reference dispatcher not started: OXY_FILE_REFERENCES_ENABLED=false');
    return;
  }
  if (!canAuthenticateAsOxyService()) {
    // Announced, not silent: "references are not being sent" must be a log
    // line. The outbox keeps filling and drains once a task can authenticate.
    log.general.warn(
      '[Files] reference dispatcher not started: no attestable workload identity and no ' +
        'OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET pair',
    );
    return;
  }
  stopping = false;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  }, config.files.syncIntervalMs);
  timer.unref?.();
  log.general.info(
    { intervalMs: config.files.syncIntervalMs, dryRun: config.files.reconcileDryRun },
    '[Files] reference dispatcher started',
  );
}

/** Stop claiming, and let the tick in flight reach a durable state. */
export async function stopFileReferenceDispatcher(): Promise<void> {
  stopping = true;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  await inFlight;
}

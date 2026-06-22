/**
 * BullMQ consumers (workers) for the marketplace queues.
 *
 * `startWorkers` is a no-op when Redis is not configured (jobs run inline via
 * the producers instead). When enabled it creates the events + maintenance
 * workers, attaches error logging, and registers the repeatable schedules.
 * `shutdownQueues` closes workers, queues, and the connection — safe to call
 * when nothing started.
 */

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { getQueueConnection, isQueueEnabled, closeQueueConnection } from './connection.js';
import { closeQueues } from './queues.js';
import { registerSchedules, removeSchedules } from './scheduler.js';
import {
  MARKETPLACE_EVENTS_QUEUE,
  MARKETPLACE_MAINTENANCE_QUEUE,
  MOOVO_DISPATCH_QUEUE,
  MOOVO_MAINTENANCE_QUEUE,
  EVENTS_WORKER_CONCURRENCY,
  MAINTENANCE_WORKER_CONCURRENCY,
  DISPATCH_WORKER_CONCURRENCY,
  JOB_RECOMPUTE_AGGREGATES,
  JOB_ORDER_EVENT_NOTIFICATION,
  JOB_LOW_INVENTORY_ALERT,
  JOB_EXPIRE_RESERVATIONS,
  JOB_RECOMPUTE_AGGREGATES_SWEEP,
  JOB_DISPATCH_WAVE,
  JOB_EXPIRE_OFFERS,
} from './constants.js';
import {
  handleRecomputeAggregates,
  handleOrderEventNotification,
  handleLowInventoryAlert,
  handleExpireReservations,
  handleAggregateSweep,
} from './handlers.js';
import { handleExpireOffers, handleDispatchWave } from './dispatch-handlers.js';
import { log } from '../lib/logger.js';
import type {
  MarketplaceEventJobData,
  MaintenanceJobData,
  DispatchJobData,
  MoovoMaintenanceJobData,
} from './types.js';
import type {
  RecomputeAggregatesJob,
  OrderEventNotificationJob,
  LowInventoryAlertJob,
  DispatchWaveJob,
} from './types.js';

let eventsWorker: Worker<MarketplaceEventJobData> | null = null;
let maintenanceWorker: Worker<MaintenanceJobData> | null = null;
let dispatchWorker: Worker<DispatchJobData> | null = null;
let moovoMaintenanceWorker: Worker<MoovoMaintenanceJobData> | null = null;
let workersStarted = false;

/** Process one events-queue job, dispatching on its job name. */
async function processEventJob(job: Job<MarketplaceEventJobData>): Promise<void> {
  switch (job.name) {
    case JOB_RECOMPUTE_AGGREGATES:
      await handleRecomputeAggregates(job.data as RecomputeAggregatesJob);
      return;
    case JOB_ORDER_EVENT_NOTIFICATION:
      await handleOrderEventNotification(job.data as OrderEventNotificationJob);
      return;
    case JOB_LOW_INVENTORY_ALERT:
      await handleLowInventoryAlert(job.data as LowInventoryAlertJob);
      return;
    default:
      throw new UnrecoverableError(`Unknown marketplace event job: ${job.name}`);
  }
}

/** Process one maintenance-queue job, dispatching on its job name. */
async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<void> {
  switch (job.name) {
    case JOB_EXPIRE_RESERVATIONS:
      await handleExpireReservations();
      return;
    case JOB_RECOMPUTE_AGGREGATES_SWEEP:
      await handleAggregateSweep();
      return;
    default:
      throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
  }
}

/** Process one transport dispatch-queue job, dispatching on its job name. */
async function processDispatchJob(job: Job<DispatchJobData>): Promise<void> {
  switch (job.name) {
    case JOB_DISPATCH_WAVE:
      await handleDispatchWave(job.data as DispatchWaveJob);
      return;
    default:
      throw new UnrecoverableError(`Unknown dispatch job: ${job.name}`);
  }
}

/** Process one transport maintenance-queue job, dispatching on its job name. */
async function processMoovoMaintenanceJob(job: Job<MoovoMaintenanceJobData>): Promise<void> {
  switch (job.name) {
    case JOB_EXPIRE_OFFERS:
      await handleExpireOffers();
      return;
    default:
      throw new UnrecoverableError(`Unknown transport maintenance job: ${job.name}`);
  }
}

/**
 * Start the marketplace queue workers for this process. Idempotent; a no-op when
 * Redis is not configured (jobs run inline via the producers).
 */
export function startWorkers(): void {
  if (workersStarted) {
    return;
  }
  if (!isQueueEnabled()) {
    log.general.info('Marketplace queue disabled (REDIS_URL not set) — jobs run inline');
    return;
  }
  workersStarted = true;

  const connection = getQueueConnection();

  eventsWorker = new Worker<MarketplaceEventJobData>(MARKETPLACE_EVENTS_QUEUE, processEventJob, {
    connection,
    concurrency: EVENTS_WORKER_CONCURRENCY,
  });

  maintenanceWorker = new Worker<MaintenanceJobData>(
    MARKETPLACE_MAINTENANCE_QUEUE,
    processMaintenanceJob,
    { connection, concurrency: MAINTENANCE_WORKER_CONCURRENCY },
  );

  dispatchWorker = new Worker<DispatchJobData>(MOOVO_DISPATCH_QUEUE, processDispatchJob, {
    connection,
    concurrency: DISPATCH_WORKER_CONCURRENCY,
  });

  moovoMaintenanceWorker = new Worker<MoovoMaintenanceJobData>(
    MOOVO_MAINTENANCE_QUEUE,
    processMoovoMaintenanceJob,
    { connection, concurrency: MAINTENANCE_WORKER_CONCURRENCY },
  );

  for (const worker of [eventsWorker, maintenanceWorker, dispatchWorker, moovoMaintenanceWorker]) {
    worker.on('failed', (job, err) => {
      const jobId = job?.id ?? 'unknown';
      log.general.warn({ queue: worker.name, jobId, err: err.message }, 'Queue job failed');
    });
    worker.on('error', (err) => {
      log.general.error({ queue: worker.name, err }, 'Queue worker error');
    });
  }

  registerSchedules().catch((err) =>
    log.general.error({ err }, 'Failed to register repeatable jobs'),
  );

  log.general.info('Marketplace + transport workers started');
}

/**
 * Close workers, producer queues, and the connection. Safe to call when nothing
 * started. The shared repeatable schedules are removed ONLY if THIS process
 * registered them (i.e. it started workers) — a web-only process (Redis
 * configured but workers never started) must not unregister fleet-wide schedules.
 */
export async function shutdownQueues(): Promise<void> {
  const didStartWorkers = workersStarted;
  if (!workersStarted && !isQueueEnabled()) {
    return;
  }

  if (didStartWorkers) {
    await removeSchedules().catch((err) =>
      log.general.warn({ err }, 'Failed to remove marketplace repeatable jobs'),
    );
  }

  const workers: Array<
    | Worker<MarketplaceEventJobData>
    | Worker<MaintenanceJobData>
    | Worker<DispatchJobData>
    | Worker<MoovoMaintenanceJobData>
  > = [];
  if (eventsWorker) workers.push(eventsWorker);
  if (maintenanceWorker) workers.push(maintenanceWorker);
  if (dispatchWorker) workers.push(dispatchWorker);
  if (moovoMaintenanceWorker) workers.push(moovoMaintenanceWorker);

  await Promise.allSettled(workers.map((w) => w.close()));

  eventsWorker = null;
  maintenanceWorker = null;
  dispatchWorker = null;
  moovoMaintenanceWorker = null;
  workersStarted = false;

  await closeQueues();
  await closeQueueConnection();

  log.general.info('Marketplace + transport queues closed');
}

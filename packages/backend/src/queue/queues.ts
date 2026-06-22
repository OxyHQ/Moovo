/**
 * Lazily-constructed BullMQ producer queues for the marketplace.
 *
 * Queues are created on first access (never at import time) so merely importing
 * this module is side-effect free (important for tests that run without Redis).
 * Each accessor returns `null` when Redis is not configured; producers then fall
 * back to running the handler inline (see `producers.ts`).
 */

import { Queue, type QueueOptions } from 'bullmq';
import { getQueueConnection, isQueueEnabled } from './connection.js';
import {
  MARKETPLACE_EVENTS_QUEUE,
  MARKETPLACE_MAINTENANCE_QUEUE,
  MOOVO_DISPATCH_QUEUE,
  MOOVO_MAINTENANCE_QUEUE,
  EVENTS_JOB_ATTEMPTS,
  EVENTS_BACKOFF_BASE_MS,
  MAINTENANCE_JOB_ATTEMPTS,
  DISPATCH_JOB_ATTEMPTS,
  REMOVE_ON_COMPLETE_COUNT,
  REMOVE_ON_FAIL_COUNT,
} from './constants.js';
import type {
  MarketplaceEventJobData,
  MaintenanceJobData,
  DispatchJobData,
  MoovoMaintenanceJobData,
} from './types.js';

/** Shared default job options (retention + retry/backoff) for a queue. */
function baseQueueOptions(attempts: number): QueueOptions {
  return {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: EVENTS_BACKOFF_BASE_MS },
      removeOnComplete: { count: REMOVE_ON_COMPLETE_COUNT },
      removeOnFail: { count: REMOVE_ON_FAIL_COUNT },
    },
  };
}

let eventsQueue: Queue<MarketplaceEventJobData> | null = null;
let maintenanceQueue: Queue<MaintenanceJobData> | null = null;
let dispatchQueue: Queue<DispatchJobData> | null = null;
let moovoMaintenanceQueue: Queue<MoovoMaintenanceJobData> | null = null;

/** Get the events queue, or null when Redis is not configured. */
export function getEventsQueue(): Queue<MarketplaceEventJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!eventsQueue) {
    eventsQueue = new Queue<MarketplaceEventJobData>(
      MARKETPLACE_EVENTS_QUEUE,
      baseQueueOptions(EVENTS_JOB_ATTEMPTS),
    );
  }
  return eventsQueue;
}

/**
 * Get the maintenance (repeatable-job) queue, or null when Redis is not
 * configured. Repeatable schedules are registered onto this queue by
 * `scheduler.ts`.
 */
export function getMaintenanceQueue(): Queue<MaintenanceJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue<MaintenanceJobData>(
      MARKETPLACE_MAINTENANCE_QUEUE,
      baseQueueOptions(MAINTENANCE_JOB_ATTEMPTS),
    );
  }
  return maintenanceQueue;
}

/** Get the transport dispatch queue, or null when Redis is not configured. */
export function getDispatchQueue(): Queue<DispatchJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!dispatchQueue) {
    dispatchQueue = new Queue<DispatchJobData>(
      MOOVO_DISPATCH_QUEUE,
      baseQueueOptions(DISPATCH_JOB_ATTEMPTS),
    );
  }
  return dispatchQueue;
}

/**
 * Get the transport maintenance (repeatable-job) queue, or null when Redis is
 * not configured. The offer-expiry sweep is registered onto this queue by
 * `scheduler.ts`.
 */
export function getMoovoMaintenanceQueue(): Queue<MoovoMaintenanceJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!moovoMaintenanceQueue) {
    moovoMaintenanceQueue = new Queue<MoovoMaintenanceJobData>(
      MOOVO_MAINTENANCE_QUEUE,
      baseQueueOptions(MAINTENANCE_JOB_ATTEMPTS),
    );
  }
  return moovoMaintenanceQueue;
}

/** Close all open producer queues and null them. Used by {@link shutdownQueues}. */
export async function closeQueues(): Promise<void> {
  const open: Array<
    | Queue<MarketplaceEventJobData>
    | Queue<MaintenanceJobData>
    | Queue<DispatchJobData>
    | Queue<MoovoMaintenanceJobData>
  > = [];
  if (eventsQueue) open.push(eventsQueue);
  if (maintenanceQueue) open.push(maintenanceQueue);
  if (dispatchQueue) open.push(dispatchQueue);
  if (moovoMaintenanceQueue) open.push(moovoMaintenanceQueue);

  await Promise.allSettled(open.map((q) => q.close()));

  eventsQueue = null;
  maintenanceQueue = null;
  dispatchQueue = null;
  moovoMaintenanceQueue = null;
}

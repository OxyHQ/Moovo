/**
 * Explicit, fully-typed job payloads for the Moovo marketplace BullMQ
 * queues. Payloads carry only plain JSON-serializable data — BullMQ persists
 * them in Redis, so no Mongoose documents, class instances, or functions may be
 * placed here.
 */

import type { ReviewTargetType } from '@moovo/shared-types';

/** Recompute one review target's rating aggregate (drift-proof backstop). */
export interface RecomputeAggregatesJob {
  targetType: ReviewTargetType;
  targetId: string;
}

/** The order lifecycle event that drives buyer/seller notifications. */
export type OrderEvent = 'placed' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

/** Deliver order-event notifications to the buyer + seller. */
export interface OrderEventNotificationJob {
  orderId: string;
  event: OrderEvent;
}

/** Alert store managers that a tracked variant dropped to/below the threshold. */
export interface LowInventoryAlertJob {
  storeId: string;
  listingId: string;
  variantId: string;
  variantTitle: string;
  available: number;
}

/** Periodic reservation-sweep job — no payload. */
export type ExpireReservationsJob = Record<string, never>;

/** Periodic offer-expiry + re-dispatch sweep — no payload. */
export type ExpireOffersJob = Record<string, never>;

/** Dispatch (or re-dispatch) one job to a fresh wave of nearby couriers. */
export interface DispatchWaveJob {
  /** The job to (re-)dispatch. */
  jobId: string;
}

/** Job names enqueued onto the events queue. */
export type MarketplaceEventJobName =
  | 'recompute-aggregates'
  | 'order-event-notification'
  | 'low-inventory-alert';

/** Job names enqueued onto the maintenance (repeatable) queue. */
export type MaintenanceJobName = 'expire-reservations' | 'recompute-aggregates-sweep';

/** Job names enqueued onto the transport dispatch queue. */
export type DispatchJobName = 'dispatch-wave';

/** Job names enqueued onto the transport maintenance (repeatable) queue. */
export type MoovoMaintenanceJobName = 'expire-offers';

/** Union of every event-queue job payload. */
export type MarketplaceEventJobData =
  | RecomputeAggregatesJob
  | OrderEventNotificationJob
  | LowInventoryAlertJob;

/** Union of every maintenance-queue job payload. */
export type MaintenanceJobData = ExpireReservationsJob | RecomputeAggregatesJob;

/** Union of every transport dispatch-queue job payload. */
export type DispatchJobData = DispatchWaveJob;

/** Union of every transport maintenance-queue job payload. */
export type MoovoMaintenanceJobData = ExpireOffersJob;

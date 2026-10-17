/**
 * The loop that settles external-carrier bookings whose outcome is unknown.
 *
 * A carrier call that throws anything but a definite refusal leaves its claim
 * `unknown` — the carrier may have booked. Before this loop nothing ever looked
 * at such a claim again, so the shipment could never be booked nor its job
 * created. Each tick asks the carrier, by the attempt's operation id, what it
 * holds (`reconcileExternalBooking`): a booking becomes the job, no booking
 * frees the shipment to be booked again.
 *
 * Runs on every task, like the tracking poller: each claim is taken by a
 * compare-and-swap on its `updated_at`, so tasks never ask about the same
 * claim twice in one window. Not BullMQ, which only runs where `REDIS_URL` is
 * set — a reconciler that silently does not exist is the failure being fixed.
 */

import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import {
  type BookingReconciliation,
  listUnknownBookingShipments,
  reconcileExternalBooking,
} from './job.service.js';

/** Claims looked at per tick. Unknown outcomes are rare; this bounds a bad day. */
const BATCH_SIZE = 20;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

/** One tick: reconcile every claim that has been unknown past the window. */
export async function reconcileUnknownBookings(): Promise<BookingReconciliation[]> {
  const outcomes: BookingReconciliation[] = [];
  for (const shipmentId of await listUnknownBookingShipments(BATCH_SIZE)) {
    try {
      outcomes.push(await reconcileExternalBooking(shipmentId));
    } catch (err) {
      log.general.error({ err, shipmentId }, 'Booking reconciliation failed');
    }
  }
  return outcomes;
}

export function startBookingReconciler(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = reconcileUnknownBookings()
      .catch((err: unknown) => log.general.error({ err }, 'Booking reconciliation tick failed'))
      .finally(() => {
        inFlight = null;
      });
  }, config.jobs.bookingReconcileIntervalMs);
  timer.unref?.();
  log.general.info(
    { everyMs: config.jobs.bookingReconcileIntervalMs },
    'Booking reconciler started',
  );
}

export async function stopBookingReconciler(): Promise<void> {
  if (timer !== null) clearInterval(timer);
  timer = null;
  await inFlight;
}

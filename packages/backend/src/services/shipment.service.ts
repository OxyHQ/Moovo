/**
 * Shipment service — create + list + cancel a customer's shipments.
 *
 * `createShipment` persists the shipment in `quoting`, then synchronously
 * generates quotes via `quote.service` (which flips it to `quoted` once the
 * internal quote lands). Ownership is enforced HERE by throwing typed
 * `MoovoError`s (`NOT_FOUND`/`FORBIDDEN`) that thin controllers map onto the
 * response. Shipment DTOs are built ONLY through `shipment-hydration.service`;
 * this module loads records and delegates serialization.
 */

import type { CreateShipmentInput, ShipmentStatus, ShipmentType } from '@moovo/shared-types';
import {
  countShipmentsForSender,
  findShipmentById,
  insertShipment,
  listShipmentsForSender,
  markShipmentCancelled,
} from '../db/transport/shipmentRepository.js';
import type { SchedulingValue, ShipmentRecord } from '../db/transport/shipmentShape.js';
import { quoteShipment } from './quote.service.js';
import { conflict, forbidden, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Map the input scheduling DTO to the persisted shape (parsing the ISO time). */
function toScheduling(input: CreateShipmentInput['scheduling']): SchedulingValue {
  if (!input || input.kind === 'now') {
    return { kind: 'now' };
  }
  return { kind: 'scheduled', scheduledFor: new Date(input.scheduledFor) };
}

/** Offset-paginated list parameters. */
interface ListParams {
  page: number;
  limit: number;
  status?: ShipmentStatus;
  type?: ShipmentType;
}

/** A page of shipment records plus the total matching count (controller paginates). */
export interface ShipmentPage {
  data: ShipmentRecord[];
  total: number;
}

/**
 * Create a shipment for `senderOxyUserId` and generate its quotes. The shipment
 * is persisted in `quoting`; `quoteShipment` writes the internal + provider
 * quotes and flips it to `quoted`. Returns the up-to-date shipment record.
 */
export async function createShipment(
  senderOxyUserId: string,
  input: CreateShipmentInput,
): Promise<ShipmentRecord> {
  const created = await insertShipment({
    senderOxyUserId,
    type: input.type,
    status: 'quoting',
    pickup: input.pickup,
    dropoff: input.dropoff,
    parcel: input.parcel,
    itemDescription: input.itemDescription,
    photos: input.photos ?? [],
    scheduling: toScheduling(input.scheduling),
  });

  await quoteShipment(created);

  // Re-read: `quoteShipment` writes the distance and flips the status, so the
  // caller is handed the shipment as it now stands rather than as it was.
  const refreshed = await findShipmentById(created.id);
  if (!refreshed) {
    throw notFound('Shipment not found');
  }
  log.general.info(
    { shipmentId: refreshed.id, senderOxyUserId, type: refreshed.type },
    'Created shipment',
  );
  return refreshed;
}

/** List the caller's own shipments (newest first), with the total count. */
export async function listMine(
  senderOxyUserId: string,
  { page, limit, status, type }: ListParams,
): Promise<ShipmentPage> {
  const filter = { senderOxyUserId, status, type };
  const [data, total] = await Promise.all([
    listShipmentsForSender(filter, { page, limit }),
    countShipmentsForSender(filter),
  ]);
  return { data, total };
}

/** Get a single shipment owned by the caller, or throw NOT_FOUND/FORBIDDEN. */
export async function getMine(senderOxyUserId: string, id: string): Promise<ShipmentRecord> {
  const record = await findShipmentById(id);
  if (!record) {
    throw notFound('Shipment not found');
  }
  if (record.senderOxyUserId !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  return record;
}

/**
 * Cancel the caller's own shipment. Only a non-booked, non-terminal shipment may
 * be cancelled; a booked shipment is managed through its job.
 *
 * The three refusals stay in the service rather than becoming one WHERE clause:
 * each raises a distinct typed error that a controller maps to a distinct
 * response, and a predicate that simply matched no rows could not tell "already
 * cancelled" from "not yours" from "does not exist".
 */
export async function cancel(senderOxyUserId: string, id: string): Promise<ShipmentRecord> {
  const record = await findShipmentById(id);
  if (!record) {
    throw notFound('Shipment not found');
  }
  if (record.senderOxyUserId !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  if (record.status === 'booked') {
    throw conflict('A booked shipment cannot be cancelled; cancel its job instead');
  }
  if (record.status === 'cancelled' || record.status === 'expired') {
    throw conflict(`Shipment is already ${record.status}`);
  }
  const cancelled = await markShipmentCancelled(id);
  if (!cancelled) {
    throw notFound('Shipment not found');
  }
  log.general.info({ shipmentId: id, senderOxyUserId }, 'Cancelled shipment');
  return cancelled;
}

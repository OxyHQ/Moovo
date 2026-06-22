/**
 * Shipment service — create + list + cancel a customer's shipments.
 *
 * `createShipment` persists the shipment in `quoting`, then synchronously
 * generates quotes via `quote.service` (which flips it to `quoted` once the
 * internal quote lands). Ownership is enforced HERE by throwing typed
 * `MoovoError`s (`NOT_FOUND`/`FORBIDDEN`) that thin controllers map onto the
 * response. Shipment DTOs are built ONLY through `shipment-hydration.service`;
 * this module loads docs and delegates serialization.
 */

import type { CreateShipmentInput } from '@moovo/shared-types';
import { Shipment, type IShipment, type IScheduling } from '../models/shipment.js';
import { quoteShipment } from './quote.service.js';
import { conflict, forbidden, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Map the input scheduling DTO to the persisted shape (parsing the ISO time). */
function toScheduling(input: CreateShipmentInput['scheduling']): IScheduling {
  if (!input || input.kind === 'now') {
    return { kind: 'now' };
  }
  return { kind: 'scheduled', scheduledFor: new Date(input.scheduledFor) };
}

/** Offset-paginated list parameters. */
interface ListParams {
  page: number;
  limit: number;
  status?: IShipment['status'];
  type?: IShipment['type'];
}

/** A page of shipment docs plus the total matching count (controller paginates). */
export interface ShipmentPage {
  data: IShipment[];
  total: number;
}

/**
 * Create a shipment for `senderOxyUserId` and generate its quotes. The shipment
 * is persisted in `quoting`; `quoteShipment` writes the internal + provider
 * quotes and flips it to `quoted`. Returns the up-to-date shipment doc.
 */
export async function createShipment(
  senderOxyUserId: string,
  input: CreateShipmentInput,
): Promise<IShipment> {
  const created = await Shipment.create({
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

  const shipment = created.toObject<IShipment>();
  await quoteShipment(shipment);

  const refreshed = await Shipment.findById(created._id).lean<IShipment | null>();
  if (!refreshed) {
    throw notFound('Shipment not found');
  }
  log.general.info(
    { shipmentId: String(refreshed._id), senderOxyUserId, type: refreshed.type },
    'Created shipment',
  );
  return refreshed;
}

/** List the caller's own shipments (newest first), with the total count. */
export async function listMine(
  senderOxyUserId: string,
  { page, limit, status, type }: ListParams,
): Promise<ShipmentPage> {
  const filter = {
    senderOxyUserId,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
  };
  const [docs, total] = await Promise.all([
    Shipment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<IShipment[]>(),
    Shipment.countDocuments(filter),
  ]);
  return { data: docs, total };
}

/** Get a single shipment owned by the caller, or throw NOT_FOUND/FORBIDDEN. */
export async function getMine(senderOxyUserId: string, id: string): Promise<IShipment> {
  const doc = await Shipment.findById(id).lean<IShipment | null>();
  if (!doc) {
    throw notFound('Shipment not found');
  }
  if (String(doc.senderOxyUserId) !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  return doc;
}

/**
 * Cancel the caller's own shipment. Only a non-booked, non-terminal shipment may
 * be cancelled; a booked shipment is managed through its job.
 */
export async function cancel(senderOxyUserId: string, id: string): Promise<IShipment> {
  const doc = await Shipment.findById(id);
  if (!doc) {
    throw notFound('Shipment not found');
  }
  if (String(doc.senderOxyUserId) !== senderOxyUserId) {
    throw forbidden('You do not own this shipment');
  }
  if (doc.status === 'booked') {
    throw conflict('A booked shipment cannot be cancelled; cancel its job instead');
  }
  if (doc.status === 'cancelled' || doc.status === 'expired') {
    throw conflict(`Shipment is already ${doc.status}`);
  }
  doc.status = 'cancelled';
  await doc.save();
  log.general.info({ shipmentId: id, senderOxyUserId }, 'Cancelled shipment');
  return doc.toObject<IShipment>();
}

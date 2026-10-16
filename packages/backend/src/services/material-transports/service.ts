import { createHash } from 'node:crypto';
import { and, desc, eq, ne, sql, inArray } from 'drizzle-orm';
import {
  CreateTransport,
  AuthorizeTransport,
  Transport,
  type TransportRequest,
  type TransportAuthorizationInput,
  type TransportEndpoint,
} from '@oxy.so/moovo-contracts';
import { getDb } from '../../db/postgres';
import { materialTransports as transports } from '../../db/schema/material-transports';
import {
  findShipmentById,
  insertShipment,
  markShipmentCancelled,
} from '../../db/transport/shipmentRepository';
import { findQuoteById, listActiveQuotesForShipment } from '../../db/transport/quoteRepository';
import { findJobById } from '../../db/transport/jobRepository';
import { bookShipment } from '../job.service';
import { quoteShipment } from '../quote.service';
import { authorizeAccount, readReservation, TransportError, type TransportCaller } from './access';
type Row = typeof transports.$inferSelect;
const fail = (code: 'conflict' | 'not_found' | 'forbidden', message: string): never => {
  throw new TransportError(code, message);
};
const endpoint = ({ latitude, longitude, ...rest }: TransportEndpoint) => ({
  ...rest,
  location: { type: 'Point' as const, coordinates: [longitude, latitude] },
});
async function load(id: string) {
  const [row] = await getDb().select().from(transports).where(eq(transports.id, id));
  return row ?? fail('not_found', 'Transport not found');
}
async function access(caller: TransportCaller, row: Row, accountId: string) {
  await authorizeAccount(caller, accountId);
  if (
    ![
      row.requestingAccountId,
      row.donorAccountId,
      row.recipientAccountId,
      row.payerAccountId,
    ].includes(accountId)
  )
    fail('not_found', 'Transport not found');
}
async function accepted(caller: TransportCaller, reservationId: string, accountId: string) {
  const reservation = await readReservation(caller, reservationId, accountId);
  if (reservation.status !== 'accepted')
    fail(
      'conflict',
      'Only an accepted reservation can request transport; existing bookings must be managed separately in Moovo',
    );
  return reservation;
}
async function view(row: Row) {
  const shipment = await findShipmentById(row.shipmentId);
  if (!shipment) fail('not_found', 'Transport shipment not found');
  const job = shipment?.jobId ? await findJobById(shipment.jobId) : null;
  const quotes = await listActiveQuotesForShipment(row.shipmentId);
  return Transport.parse({
    pickup: {
      address: shipment.pickup.address,
      contactName: shipment.pickup.contactName,
      contactPhone: shipment.pickup.contactPhone,
      notes: shipment.pickup.notes,
      latitude: shipment.pickup.location.coordinates[1],
      longitude: shipment.pickup.location.coordinates[0],
    },
    dropoff: {
      address: shipment.dropoff.address,
      contactName: shipment.dropoff.contactName,
      contactPhone: shipment.dropoff.contactPhone,
      notes: shipment.dropoff.notes,
      latitude: shipment.dropoff.location.coordinates[1],
      longitude: shipment.dropoff.location.coordinates[0],
    },
    parcel: shipment.parcel,
    itemDescription: shipment.itemDescription,
    id: row.id,
    reservationId: row.reservationId,
    requestingAccountId: row.requestingAccountId,
    payerAccountId: row.payerAccountId,
    status: job ? 'booked' : row.status,
    quotes: quotes
      .filter((q) => q.source === 'moovo_courier' && q.expiresAt.getTime() > Date.now())
      .map((q) => ({
        id: q.id,
        amountMinor: q.priceBreakdown.total.fairMinor,
        currency: 'FAIR',
        expiresAt: q.expiresAt.toISOString(),
        fulfillment: 'moovo_courier',
      })),
    authorization: row.authorizedQuoteId
      ? {
          payerAccountId: row.payerAccountId,
          actorAccountId: row.authorizedActorAccountId,
          quoteId: row.authorizedQuoteId,
          amountMinor: row.authorizedAmountMinor,
          currency: 'FAIR',
          expiresAt: row.authorizationExpiresAt?.toISOString(),
        }
      : null,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    paymentStatus: 'pending',
    paymentCollectionAvailable: false,
    createdAt: row.createdAt.toISOString(),
  });
}
export async function getTransport(caller: TransportCaller, id: string, accountId: string) {
  const row = await load(id);
  await access(caller, row, accountId);
  return view(row);
}
export async function transportForReservation(
  caller: TransportCaller,
  id: string,
  accountId: string,
) {
  await readReservation(caller, id, accountId);
  const [row] = await getDb()
    .select()
    .from(transports)
    .where(eq(transports.reservationId, id))
    .orderBy(desc(transports.createdAt), desc(transports.id))
    .limit(1);
  if (!row) return fail('not_found', 'No transport has been requested');
  await access(caller, row, accountId);
  return view(row);
}
export async function createTransport(caller: TransportCaller, input: TransportRequest) {
  const body = CreateTransport.parse(input);
  await authorizeAccount(caller, body.actingAccountId);
  const reservation = await accepted(caller, body.reservationId, body.actingAccountId);
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  // Transactional unique admission; shipment and request commit together. A lost response
  // can always be resolved by reservation ID. Never create a second shipment on retry.
  const result = await getDb().transaction(async (tx) => {
    // Advisory lock serializes two initiators as well as repeats of one operation.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mercaria:${body.reservationId}`}, 0))`,
    );
    const [replay] = await tx
      .select()
      .from(transports)
      .where(
        and(
          eq(transports.requestingAccountId, body.actingAccountId),
          eq(transports.operationId, body.operationId),
        ),
      );
    if (replay) {
      if (replay.inputHash !== hash)
        fail('conflict', 'This operation ID belongs to different transport details');
      return { row: replay, created: false };
    }
    const [prior] = await tx
      .select()
      .from(transports)
      .where(
        and(eq(transports.reservationId, body.reservationId), ne(transports.status, 'cancelled')),
      );
    if (prior) {
      if (prior.inputHash !== hash)
        fail('conflict', 'This reservation already has a transport request; open that request');
      return { row: prior, created: false };
    }
    const shipment = await insertShipment(
      {
        senderOxyUserId: body.actingAccountId,
        type: 'package',
        status: 'quoting',
        pickup: endpoint(body.pickup),
        dropoff: endpoint(body.dropoff),
        parcel: body.parcel,
        itemDescription: body.itemDescription,
        photos: [],
        scheduling: { kind: 'now' },
      },
      tx,
    );
    const [row] = await tx
      .insert(transports)
      .values({
        reservationId: body.reservationId,
        requestingAccountId: body.actingAccountId,
        payerAccountId: body.payerAccountId,
        donorAccountId: reservation.donorAccountId,
        recipientAccountId: reservation.requesterAccountId,
        operationId: body.operationId,
        inputHash: hash,
        shipmentId: shipment.id,
      })
      .returning();
    return { row, created: true };
  });
  await ensureQuoted(result.row, result.created);
  return view(await load(result.row.id));
}
/** The durable request is also the quote lease. Restart/retry never creates a shipment. */
async function ensureQuoted(row: Row, newlyCreated = false) {
  if (!['quoting', 'quoted', 'authorized'].includes(row.status)) return;
  const active = await listActiveQuotesForShipment(row.shipmentId);
  if (active.some((q) => q.source === 'moovo_courier' && q.expiresAt.getTime() > Date.now())) {
    if (row.status === 'quoting')
      await getDb()
        .update(transports)
        .set({ status: 'quoted' })
        .where(and(eq(transports.id, row.id), eq(transports.status, 'quoting')));
    return;
  }
  if (!newlyCreated) {
    // A crashed worker's read-only quote lease expires. Normal failures release it
    // immediately below; a concurrent quote request cannot also win this CAS.
    if (row.status === 'quoting' && row.updatedAt.getTime() > Date.now() - 30000) return;
    const [claim] = await getDb()
      .update(transports)
      .set({
        status: 'quoting',
        updatedAt: new Date(),
        authorizedQuoteId: null,
        authorizedAmountMinor: null,
        authorizedActorAccountId: null,
        authorizationExpiresAt: null,
        authorizedAt: null,
      })
      .where(
        and(
          eq(transports.id, row.id),
          eq(transports.status, row.status),
          eq(transports.updatedAt, row.updatedAt),
        ),
      )
      .returning();
    if (!claim) return;
  }
  try {
    const shipment = await findShipmentById(row.shipmentId);
    if (shipment) await quoteShipment(shipment);
    await getDb()
      .update(transports)
      .set({ status: 'quoted' })
      .where(and(eq(transports.id, row.id), eq(transports.status, 'quoting')));
  } catch (error) {
    await getDb()
      .update(transports)
      .set({ updatedAt: new Date(0) })
      .where(and(eq(transports.id, row.id), eq(transports.status, 'quoting')));
    throw error;
  }
}
export async function quoteTransport(caller: TransportCaller, id: string, accountId: string) {
  const row = await load(id);
  await access(caller, row, accountId);
  await accepted(caller, row.reservationId, accountId);
  await ensureQuoted(row);
  return view(await load(id));
}
export async function authorizeTransport(
  caller: TransportCaller,
  id: string,
  input: TransportAuthorizationInput,
) {
  const body = AuthorizeTransport.parse(input);
  const row = await load(id);
  if (row.payerAccountId !== body.actingAccountId)
    fail('forbidden', 'Only the selected payer may authorize this transport');
  await authorizeAccount(
    caller,
    body.actingAccountId,
    true,
    ![row.donorAccountId, row.recipientAccountId].includes(row.payerAccountId),
  );
  const quote = await findQuoteById(body.quoteId);
  if (
    !quote ||
    quote.shipmentId !== row.shipmentId ||
    quote.source !== 'moovo_courier' ||
    quote.priceBreakdown.total.fairMinor !== body.amountMinor ||
    quote.expiresAt.getTime() <= Date.now()
  )
    fail('conflict', 'The displayed quote has expired or changed');
  if (
    row.status === 'authorized' &&
    row.authorizedQuoteId === body.quoteId &&
    row.authorizedActorAccountId === caller.actorAccountId
  )
    return view(row);
  if (row.status !== 'quoted' || quote.status !== 'active')
    fail('conflict', 'This transport is no longer awaiting authorization');
  const [updated] = await getDb()
    .update(transports)
    .set({
      status: 'authorized',
      authorizedQuoteId: quote.id,
      authorizedAmountMinor: body.amountMinor,
      authorizedActorAccountId: caller.actorAccountId,
      authorizedAt: new Date(),
      authorizationExpiresAt: quote.expiresAt,
    })
    .where(and(eq(transports.id, id), eq(transports.status, 'quoted')))
    .returning();
  if (!updated) fail('conflict', 'Transport changed; refresh before authorizing');
  return view(updated);
}
export async function bookTransport(caller: TransportCaller, id: string, accountId: string) {
  let row = await load(id);
  await access(caller, row, accountId);
  // Sponsors authorize only. A reservation participant rechecks the source before
  // actual booking. No sponsor receives Mercaria's private collection instructions.
  if (accountId !== row.donorAccountId && accountId !== row.recipientAccountId)
    fail('forbidden', 'A donation participant must request the authorized transport');
  const current = await view(row);
  if (current.jobId) return current;
  await accepted(caller, row.reservationId, accountId);
  if (
    ['booking', 'booking_unknown'].includes(row.status) &&
    row.updatedAt.getTime() < Date.now() - 30000
  ) {
    const [recovered] = await getDb()
      .update(transports)
      .set({ status: 'authorized' })
      .where(
        and(
          eq(transports.id, id),
          eq(transports.status, row.status),
          eq(transports.updatedAt, row.updatedAt),
        ),
      )
      .returning();
    if (recovered) row = recovered;
  }
  if (
    row.status !== 'authorized' ||
    !row.authorizedQuoteId ||
    !row.authorizationExpiresAt ||
    row.authorizationExpiresAt.getTime() <= Date.now()
  )
    fail('conflict', 'A current authorization from the selected payer is required');
  const [claimed] = await getDb()
    .update(transports)
    .set({ status: 'booking' })
    .where(and(eq(transports.id, id), eq(transports.status, 'authorized')))
    .returning();
  if (!claimed) fail('conflict', 'Booking is already in progress; refresh this request');
  try {
    await bookShipment(
      row.requestingAccountId,
      row.shipmentId,
      row.authorizedQuoteId,
      `material_${row.id}`,
      row.id,
    );
    await getDb().update(transports).set({ status: 'booked' }).where(eq(transports.id, id));
  } catch (err) {
    // A timeout may follow a committed booking. Preserve the operation and do not
    // silently return to authorized, which would make a retry a fresh purchase.
    await getDb()
      .update(transports)
      .set({ status: 'booking_unknown' })
      .where(and(eq(transports.id, id), eq(transports.status, 'booking')));
    throw err;
  }
  return view(await load(id));
}
export async function cancelTransport(caller: TransportCaller, id: string, accountId: string) {
  const row = await load(id);
  await access(caller, row, accountId);
  if (row.status === 'cancelled') return view(row);
  const [cancelled] = await getDb()
    .update(transports)
    .set({ status: 'cancelled' })
    .where(
      and(eq(transports.id, id), inArray(transports.status, ['quoting', 'quoted', 'authorized'])),
    )
    .returning();
  if (!cancelled)
    fail(
      'conflict',
      'A requested or uncertain delivery must be managed in Moovo; cancelling the donation does not cancel transport',
    );
  await markShipmentCancelled(row.shipmentId);
  return view(cancelled);
}

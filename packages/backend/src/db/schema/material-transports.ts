import { check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { TRANSPORT_STATES } from '@moovo.now/contracts';
import { closedSet, foreignServiceId, moneyMinor } from './columns';
import { shipments, jobs } from './transport';

/** Moovo owns transport requests and the payer's quote-bound authorization. */
export const materialTransports = pgTable(
  'material_transports',
  {
    id: generatedId(),
    reservationId: foreignServiceId().notNull(),
    requestingAccountId: foreignServiceId().notNull(),
    payerAccountId: foreignServiceId().notNull(),
    donorAccountId: foreignServiceId().notNull(),
    recipientAccountId: foreignServiceId().notNull(),
    operationId: text().notNull(),
    inputHash: text().notNull(),
    shipmentId: text()
      .notNull()
      .references(() => shipments.id),
    status: text().notNull().default('quoting'),
    authorizedQuoteId: text(),
    authorizedAmountMinor: moneyMinor(),
    authorizedActorAccountId: foreignServiceId(),
    authorizationExpiresAt: timestamptz(),
    authorizedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('material_transports_reservation_key')
      .on(t.reservationId)
      .where(sql`${t.status} <> 'cancelled'`),
    uniqueIndex('material_transports_operation_key').on(t.requestingAccountId, t.operationId),
    check(
      'material_transports_authorized_amount_present',
      sql`${t.authorizedQuoteId} is null or ${t.authorizedAmountMinor} is not null`,
    ),
    closedSet('material_transports_status_check', t.status, TRANSPORT_STATES),
    check(
      'material_transports_authorization_shape',
      sql`(${t.authorizedQuoteId} is null and ${t.authorizedAmountMinor} is null and ${t.authorizedActorAccountId} is null and ${t.authorizationExpiresAt} is null and ${t.authorizedAt} is null) or (${t.authorizedQuoteId} is not null and ${t.authorizedAmountMinor} between 0 and 9007199254740991 and ${t.authorizedActorAccountId} is not null and ${t.authorizationExpiresAt} is not null and ${t.authorizedAt} is not null)`,
    ),
  ],
);

/** A durable claim BEFORE calling a carrier. Ambiguous attempts never auto-retry. */
export const shipmentBookingAttempts = pgTable(
  'shipment_booking_attempts',
  {
    shipmentId: text()
      .primaryKey()
      .references(() => shipments.id),
    quoteId: text().notNull(),
    senderAccountId: foreignServiceId().notNull(),
    operationId: text().notNull(),
    idempotencyKey: text(),
    status: text().notNull(),
    jobId: text().references(() => jobs.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('shipment_booking_attempts_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    closedSet('shipment_booking_attempts_status_check', t.status, [
      'processing',
      'unknown',
      'completed',
    ]),
  ],
);

/**
 * The transport half of Moovo: a request to move something, the quotes priced
 * for it, the job it becomes, and the dispatch offers made for that job.
 *
 * ## Where the geography columns are, and where they deliberately are not
 *
 * `shipments` carries GiST indexes on both endpoints, because the source
 * declares `2dsphere` on `pickup.location` and `dropoff.location`.
 *
 * `jobs` carries the same ordinates but NO spatial index, because the source
 * declares none: a job's endpoints are FROZEN SNAPSHOTS taken at booking, and
 * nothing queries jobs by position. `dispatch.service.ts` reads a job's pickup
 * point to use as the ORIGIN of a query against couriers — the job is the
 * needle, never the haystack. An index there would be paid for on every write
 * and read by nothing.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bigint } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  closedSet,
  closedSetArray,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
  moneyMinor,
} from './columns';
import {
  FAIR_CURRENCIES,
  FULFILLMENT_TYPES,
  JOB_OFFER_STATUSES,
  JOB_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  QUOTE_SOURCES,
  QUOTE_STATUSES,
  SCHEDULING_KINDS,
  SHIPMENT_STATUSES,
  SHIPMENT_TYPES,
  SIZE_CLASSES,
  SUPPORTED_CURRENCIES,
} from './valueSets';
import { courierCompanies } from './fleet';

/**
 * A registered external delivery carrier.
 *
 * `config` is opaque, NON-secret adapter configuration — credentials come from
 * the environment and are never stored here. jsonb because its shape is the
 * adapter's business, not this schema's.
 */
export const providers = pgTable(
  'providers',
  {
    id: generatedId(),
    key: text().notNull(),
    name: text().notNull(),
    logoFileId: foreignServiceId(),
    enabled: boolean().notNull().default(true),
    supportedTypes: text().array().notNull().default(sql`'{}'::text[]`),
    supportedCountries: text().array().notNull().default(sql`'{}'::text[]`),
    config: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSetArray('providers_supported_types_check', table.supportedTypes, SHIPMENT_TYPES),
    uniqueIndex('providers_key_key').on(table.key),
    index('providers_enabled_idx').on(table.enabled),
  ],
);

/**
 * A customer's request to move something — the entry point of the
 * request → quotes → booking → job lifecycle. Carries NO price.
 *
 * The two endpoints are flattened into explicit columns rather than jsonb
 * because they are READ INDIVIDUALLY: `dispatch.service.ts` takes the pickup
 * ordinates as a query origin and `buildOfferView` shows the pickup and
 * dropoff CITY to the courier. A jsonb blob would make both a runtime cast.
 */
export const shipments = pgTable(
  'shipments',
  {
    id: generatedId(),
    senderOxyUserId: foreignServiceId().notNull(),
    type: text().notNull(),
    status: text().notNull().default('draft'),

    pickupLatitude: latitude().notNull(),
    pickupLongitude: longitude().notNull(),
    pickupLocation: generatedGeographyPoint('pickup_longitude', 'pickup_latitude'),
    pickupLine1: text().notNull(),
    pickupLine2: text(),
    pickupCity: text().notNull(),
    pickupRegion: text(),
    pickupPostalCode: text().notNull(),
    pickupCountry: text().notNull(),
    pickupContactName: text().notNull(),
    pickupContactPhone: text().notNull(),
    pickupNotes: text(),

    dropoffLatitude: latitude().notNull(),
    dropoffLongitude: longitude().notNull(),
    dropoffLocation: generatedGeographyPoint('dropoff_longitude', 'dropoff_latitude'),
    dropoffLine1: text().notNull(),
    dropoffLine2: text(),
    dropoffCity: text().notNull(),
    dropoffRegion: text(),
    dropoffPostalCode: text().notNull(),
    dropoffCountry: text().notNull(),
    dropoffContactName: text().notNull(),
    dropoffContactPhone: text().notNull(),
    dropoffNotes: text(),

    parcelWeightKg: doublePrecision().notNull(),
    parcelDimsL: doublePrecision(),
    parcelDimsW: doublePrecision(),
    parcelDimsH: doublePrecision(),
    parcelSizeClass: text().notNull(),
    parcelPieces: integer().notNull().default(1),
    parcelFragile: boolean().notNull().default(false),

    /** NOT NULL, no database default — see `listings.description`. */
    itemDescription: text().notNull(),
    /** `[{fileId, alt?, position}]` — ordered value objects, read with the row. */
    photos: jsonb().notNull().default(sql`'[]'::jsonb`),

    schedulingKind: text().notNull().default('now'),
    scheduledFor: timestamptz(),

    distanceM: doublePrecision(),
    /** The selected quote. Not a foreign key — see the id-column ledger. */
    quoteRef: text(),
    /** The booked job. Not a foreign key — see the id-column ledger. */
    jobId: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('shipments_type_check', table.type, SHIPMENT_TYPES),
    closedSet('shipments_status_check', table.status, SHIPMENT_STATUSES),
    closedSet('shipments_size_class_check', table.parcelSizeClass, SIZE_CLASSES),
    /**
     * The enum CHECK for `schedulingKind` is SEPARATE and load-bearing.
     *
     * `shipment.ts`'s `pre('validate')` hook has no else-branch: an
     * unrecognised `kind` was rejected by the field's enum, never by the hook.
     * So the shape rule below must not be read as also rejecting one — it
     * covers the two legal kinds, and this constraint is what refuses a third.
     */
    closedSet('shipments_scheduling_kind_check', table.schedulingKind, SCHEDULING_KINDS),
    /**
     * `shipment.ts`'s hook, as the database states it: a `scheduled` shipment
     * carries a time and a `now` shipment does not.
     */
    check(
      'shipments_scheduling_shape_check',
      sql`(${table.schedulingKind} = 'scheduled' and ${table.scheduledFor} is not null)
       or (${table.schedulingKind} = 'now' and ${table.scheduledFor} is null)`,
    ),
    index('shipments_pickup_location_idx').using('gist', table.pickupLocation),
    index('shipments_dropoff_location_idx').using('gist', table.dropoffLocation),
    index('shipments_sender_created_idx').on(table.senderOxyUserId, table.createdAt),
    index('shipments_status_type_idx').on(table.status, table.type),
  ],
);

/**
 * A priced fulfilment option for a shipment.
 *
 * The price breakdown is EXPLICIT COLUMNS rather than jsonb, unlike the frozen
 * copies on `jobs`: a quote is live — compared against its siblings, selected,
 * and expired — so its total is a value the database should be able to order
 * by. The frozen snapshots on a job are read as a unit and never compared,
 * which is what earns them jsonb there and denies it here.
 *
 * `FairMoney.originalCurrency`/`originalAmount` are an optional audit trail of
 * what the user originally entered. The source models them PER COMPONENT, but
 * every producer (`pricing.service`, the provider adapters) writes the same
 * value to all six, and `originalAmount` is never written at all — so they are
 * stored once per breakdown. A producer that ever diverges gets per-component
 * columns in an additive migration.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: generatedId(),
    shipmentId: text()
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    providerId: text().references(() => providers.id, { onDelete: 'set null' }),
    providerQuoteRef: text(),

    baseFairMinor: moneyMinor().notNull(),
    distanceFairMinor: moneyMinor().notNull(),
    sizeFairMinor: moneyMinor().notNull(),
    surgeFairMinor: moneyMinor(),
    feesFairMinor: moneyMinor(),
    totalFairMinor: moneyMinor().notNull(),
    originalCurrency: text(),
    originalAmount: moneyMinor(),

    /** What the price is denominated in. Exactly one legal value. */
    currency: text().notNull().default('FAIR'),
    etaPickupMin: integer(),
    etaDeliveryMin: integer(),
    expiresAt: timestamptz().notNull(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('quotes_source_check', table.source, QUOTE_SOURCES),
    closedSet('quotes_status_check', table.status, QUOTE_STATUSES),
    closedSet('quotes_currency_check', table.currency, FAIR_CURRENCIES),
    closedSet('quotes_original_currency_check', table.originalCurrency, SUPPORTED_CURRENCIES),
    index('quotes_shipment_status_idx').on(table.shipmentId, table.status),
    /**
     * Required by the expiry sweep, not merely useful: the sweep deletes with
     * `expires_at <= now() - interval`, and without a LEADING btree here that
     * predicate is a full table scan on every run — the exact cost Mongo's TTL
     * index hid. `@oxyhq/db`'s expiry-coverage gate fails the build if this
     * index disappears.
     */
    index('quotes_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * The booked, in-flight unit of work created from a selected quote.
 *
 * Exactly one job per booked shipment, fulfilled EITHER by a Moovo courier or
 * by an external provider — see `jobs_fulfillment_shape_check`, which is the
 * CHECK that replaces `job.ts`'s `pre('validate')` hook and is NOT the
 * symmetric owner split `listings` and `vehicles` use. Modelling it as one
 * would forbid a legal state: a `moovo_courier` job is legitimately
 * UNASSIGNED while it is still `requested`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: generatedId(),
    jobNumber: text().notNull(),
    shipmentId: text()
      .notNull()
      .references(() => shipments.id, { onDelete: 'restrict' }),
    senderOxyUserId: foreignServiceId().notNull(),
    type: text().notNull(),
    fulfillmentType: text().notNull(),
    courierOxyUserId: foreignServiceId(),
    companyId: text().references(() => courierCompanies.id, { onDelete: 'set null' }),
    /** An external provider's own reference. Not a Moovo key. */
    providerRef: text(),

    pickupLatitude: latitude().notNull(),
    pickupLongitude: longitude().notNull(),
    pickupLocation: generatedGeographyPoint('pickup_longitude', 'pickup_latitude'),
    pickupLine1: text().notNull(),
    pickupLine2: text(),
    pickupCity: text().notNull(),
    pickupRegion: text(),
    pickupPostalCode: text().notNull(),
    pickupCountry: text().notNull(),
    pickupContactName: text().notNull(),
    pickupContactPhone: text().notNull(),
    pickupNotes: text(),

    dropoffLatitude: latitude().notNull(),
    dropoffLongitude: longitude().notNull(),
    dropoffLocation: generatedGeographyPoint('dropoff_longitude', 'dropoff_latitude'),
    dropoffLine1: text().notNull(),
    dropoffLine2: text(),
    dropoffCity: text().notNull(),
    dropoffRegion: text(),
    dropoffPostalCode: text().notNull(),
    dropoffCountry: text().notNull(),
    dropoffContactName: text().notNull(),
    dropoffContactPhone: text().notNull(),
    dropoffNotes: text(),

    parcelWeightKg: doublePrecision().notNull(),
    parcelDimsL: doublePrecision(),
    parcelDimsW: doublePrecision(),
    parcelDimsH: doublePrecision(),
    parcelSizeClass: text().notNull(),
    parcelPieces: integer().notNull().default(1),
    parcelFragile: boolean().notNull().default(false),

    /**
     * Frozen price snapshots taken at booking.
     *
     * jsonb, and this is the case that EARNS it: both are immutable copies
     * read as a whole and never compared across rows. `totalFairMinor` below
     * is GENERATED from `totals`, so the one number the product actually shows
     * a courier is a real, indexable column that cannot drift from the
     * snapshot it came from.
     */
    quoteSnapshot: jsonb().notNull(),
    totals: jsonb().notNull(),
    totalFairMinor: bigint({ mode: 'number' }).generatedAlwaysAs(
      sql`((totals -> 'total' ->> 'fairMinor')::bigint)`,
    ),

    status: text().notNull().default('requested'),

    podPhotoFileId: foreignServiceId(),
    podSignatureFileId: foreignServiceId(),
    podNote: text(),
    podRecipientName: text(),
    podAt: timestamptz(),

    paymentStatus: text().notNull().default('unpaid'),
    paymentProvider: text().notNull().default('oxy_pay'),
    paymentReference: text(),
    paidAt: timestamptz(),

    dispatchAttempts: integer().notNull().default(0),
    /** SHA-256 hex the courier's scan is verified against. */
    pickupCodeHash: text(),
    dropoffCodeHash: text(),
    /** Plaintext, surfaced ONLY in owner-scoped DTOs. */
    pickupCode: text(),
    dropoffCode: text(),

    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('jobs_type_check', table.type, SHIPMENT_TYPES),
    closedSet('jobs_fulfillment_type_check', table.fulfillmentType, FULFILLMENT_TYPES),
    closedSet('jobs_status_check', table.status, JOB_STATUSES),
    closedSet('jobs_size_class_check', table.parcelSizeClass, SIZE_CLASSES),
    closedSet('jobs_payment_status_check', table.paymentStatus, PAYMENT_STATUSES),
    closedSet('jobs_payment_provider_check', table.paymentProvider, PAYMENT_PROVIDERS),
    /**
     * `job.ts`'s hook, verbatim — and note the ASYMMETRY, which is the whole
     * point of writing it out rather than copying the `listings` shape:
     *
     *  - `moovo_courier` forbids `providerRef` and constrains NOTHING else.
     *    An unassigned job (no courier, no company) is legal and ordinary —
     *    it is what every job looks like between `requested` and `accepted`.
     *  - `external_provider` requires `providerRef` and forbids BOTH
     *    `courierOxyUserId` and `companyId`.
     */
    check(
      'jobs_fulfillment_shape_check',
      sql`(${table.fulfillmentType} = 'moovo_courier' and ${table.providerRef} is null)
       or (${table.fulfillmentType} = 'external_provider'
           and ${table.providerRef} is not null
           and ${table.courierOxyUserId} is null
           and ${table.companyId} is null)`,
    ),
    uniqueIndex('jobs_job_number_key').on(table.jobNumber),
    index('jobs_sender_created_idx').on(table.senderOxyUserId, table.createdAt),
    index('jobs_courier_status_created_idx').on(
      table.courierOxyUserId,
      table.status,
      table.createdAt,
    ),
    index('jobs_status_type_idx').on(table.status, table.type),
    index('jobs_shipment_idx').on(table.shipmentId),
    /**
     * The port of `{idempotencyKey: 1}, {unique: true, sparse: true}`.
     *
     * A PARTIAL unique index, because that is what `sparse` meant: rows
     * without the key are not in the index at all. A plain unique index would
     * behave the same for NULLs today (Postgres treats them as distinct) but
     * would also index every keyless row for nothing.
     */
    uniqueIndex('jobs_idempotency_key_key')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/** The job's audit trail. */
export const jobStatusEvents = pgTable(
  'job_status_events',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text().notNull(),
    at: timestamptz().notNull(),
    byOxyUserId: foreignServiceId(),
    note: text(),
    latitude: latitude(),
    longitude: longitude(),
    location: generatedGeographyPoint('longitude', 'latitude'),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('job_status_events_status_check', table.status, JOB_STATUSES),
    check(
      'job_status_events_location_shape_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    /**
     * Keyed on `(jobId, at, id)` because the source array was `_id: false`:
     * position in the array was its only identity, and that does not survive
     * the port. `at` plus the row id is the closest recoverable ordering.
     */
    index('job_status_events_job_at_idx').on(table.jobId, table.at, table.id),
  ],
);

/**
 * The courier's breadcrumb trail.
 *
 * A child table rather than the source's capped array: the cap existed to stop
 * one document growing without bound, which is a Mongo document-size concern
 * that does not exist here. Pruning is a retention decision for whoever owns
 * the trail, not a property of the row.
 */
export const jobLocationPings = pgTable(
  'job_location_pings',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    latitude: latitude().notNull(),
    longitude: longitude().notNull(),
    location: generatedGeographyPoint('longitude', 'latitude'),
    at: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('job_location_pings_job_at_idx').on(table.jobId, table.at, table.id)],
);

/**
 * One time-boxed dispatch offer of a job to one candidate courier.
 *
 * `distanceM` stays a stored column even though PostGIS can compute it: it is
 * pushed to the courier over the socket as part of the offer, so it is a fact
 * about what they were told, not a derivable property of current positions.
 */
export const jobOffers = pgTable(
  'job_offers',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    shipmentId: text()
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    courierOxyUserId: foreignServiceId().notNull(),
    companyId: text().references(() => courierCompanies.id, { onDelete: 'set null' }),
    status: text().notNull().default('offered'),
    offeredAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    rank: integer().notNull(),
    distanceM: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The expiry deadline, swept UNCONDITIONALLY — deliberately unlike
     * `notifications`, and the difference is worth stating because the two
     * look like the same problem and are not.
     *
     * `notifications` carried a `partialFilterExpression`, so its sweep has a
     * condition to PRESERVE and that condition became a generated column.
     * This index — `{expiresAt: 1}, {expireAfterSeconds: 0}` — carries no
     * partial filter at all: Mongo reaps ANY offer past `expiresAt`, whatever
     * its status.
     *
     * An earlier version of this schema narrowed the sweep to
     * `status <> 'offered'`, reasoning that it would protect a live offer.
     * That was wrong twice. A row past `expiresAt` is not live — it is expired
     * and merely unflipped, and the accept path refuses it either way. And the
     * narrowing disabled the BACKSTOP in precisely the situation a backstop
     * exists for: while the semantic `offered → expired` sweep runs, both
     * versions behave identically, and when it is wedged, Mongo still reaps
     * the stale row while the narrowed version keeps it forever. A change
     * invisible while everything works and absent when it does not is the
     * wrong change.
     */
  },
  (table) => [
    closedSet('job_offers_status_check', table.status, JOB_OFFER_STATUSES),
    index('job_offers_job_status_idx').on(table.jobId, table.status),
    index('job_offers_courier_status_idx').on(table.courierOxyUserId, table.status),
    /**
     * The sweep's supporting index. Must be a LEADING btree on the swept
     * column or the sweep is a sequential scan on a timer — a cost that never
     * fails, just grows every week.
     */
    index('job_offers_expires_at_idx').on(table.expiresAt),
  ],
);

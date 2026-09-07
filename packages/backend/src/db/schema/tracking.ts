/**
 * Moovo Tracker: universal parcel tracking.
 *
 * Somebody pastes a tracking number from any carrier, Moovo works out whose it
 * is, fetches the checkpoints and shows one timeline. Moovo's own deliveries
 * appear in the same list without their history being copied anywhere.
 *
 * ## Two shapes here carry the whole design, and both are easy to undo
 *
 * **`tracked_parcels` is a SHARED identity, one row per `(carrier, number)`.**
 * A thousand people watching one parcel are a thousand subscription rows
 * pointing at one identity, and the poller claims the identity — so a thousand
 * watchers cost ONE carrier call. That property is the unique index below and
 * nothing else. Making the parcel per-user, or dropping the index because "the
 * service checks first", removes it silently: everything still works and the
 * carrier bill multiplies.
 *
 * **`tracked_parcels` is ALSO the work queue.** There is no poll outbox: this
 * row already has a natural key, a natural due time (`nextPollAt`) and natural
 * dedupe, and a second queue can only drift from the schedule it mirrors. The
 * lease columns therefore live here, and the claim is the same
 * `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` statement
 * `moderationOutboxRepository` uses.
 *
 * The consequence somebody will eventually try to "simplify": unlike
 * `moderation_outboxes`, **`status` is the PARCEL's status and NEVER the
 * worker's.** There is no `pending`/`processing` queue state on this row — the
 * lease columns alone are the claim. Folding the two axes together would make
 * "delivered" and "currently being fetched" the same fact.
 *
 * ## An anonymous lookup writes here too
 *
 * A lookup with no account creates or refreshes a parcel row — that IS the
 * cache, and it is where the deduplication pays. It is born with
 * `subscriberCount = 0` and therefore `nextPollAt = NULL`, so it is never
 * fetched again on its own. Anonymous costs exactly one call, and the row is
 * reaped 30 days later by `db/expiry.ts`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  closedSet,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
} from './columns';
import {
  TRACKING_POLL_MODES,
  TRACKING_SOURCE_KINDS,
  TRACKING_STATUSES,
  TRACKING_WEBHOOK_STATES,
} from './valueSets';
import { jobs, providers } from './transport';

/** Bounds, so a carrier's free text cannot become an unbounded row. */
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_LOCATION_TEXT_LENGTH = 300;
const MAX_POLL_ERROR_LENGTH = 2_000;

/**
 * A carrier the tracker knows how to read.
 *
 * A SEPARATE table from `providers`, not an extension of it, and the two must
 * not be merged later. `providers` is the registry of carriers Moovo can HAND A
 * SHIPMENT TO: `quote.service.ts` fans out across every enabled row, and
 * `providers.supported_types` is CHECKed against `SHIPMENT_TYPES`. Seeding
 * Correos there would put a carrier Moovo has no contract with into a
 * customer's checkout. The populations barely overlap — bookable is a handful,
 * trackable is hundreds — and so do the lifecycles.
 *
 * Where they are the same carrier (DHL), `providerId` links the two rows.
 *
 * Detection patterns and check digits live in CODE, not in a column: they are
 * functions, and a regex in jsonb is a code path with no test.
 */
export const trackingCarriers = pgTable(
  'tracking_carriers',
  {
    id: generatedId(),
    /**
     * Matches the `TrackingAdapter` key, and is the FK target for
     * `tracked_parcels.carrier_key`.
     *
     * A UNIQUE CONSTRAINT rather than the unique INDEX `providers.key` uses,
     * because a constraint lands inside `CREATE TABLE` while an index is a
     * separate statement — and a foreign key added before its target index
     * exists fails at migration time.
     */
    key: text().notNull().unique('tracking_carriers_key_key'),
    name: text().notNull(),
    logoFileId: foreignServiceId(),
    /**
     * Set only when this carrier is ALSO one Moovo can book with (DHL is).
     *
     * `set null` rather than `restrict`: retiring a booking contract must not
     * stop us reading that carrier's tracking, which is a different capability
     * with different credentials.
     */
    providerId: text().references(() => providers.id, { onDelete: 'set null' }),
    enabled: boolean().notNull().default(true),
    /**
     * Where this carrier's data comes from — and a LEGAL decision per carrier,
     * which is exactly why it is a stored column. "Which carriers are we
     * parsing the public page of" has to be answerable without reading an
     * adapter, and revocable by an operator without a deploy.
     */
    sourceKind: text().notNull().default('deep_link_only'),
    pollSupported: boolean().notNull().default(false),
    webhookSupported: boolean().notNull().default(false),
    /** The carrier's own tracking page. Every carrier has one; we always link out. */
    deepLinkTemplate: text().notNull(),
    countryCodes: text().array().notNull().default(sql`'{}'::text[]`),
    /** Null means unlimited. Operator-editable; enforced by the poll budget. */
    maxCallsPerMinute: integer(),
    maxCallsPerDay: integer(),
    maxConcurrent: integer().notNull().default(2),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('tracking_carriers_source_kind_check', table.sourceKind, TRACKING_SOURCE_KINDS),
    index('tracking_carriers_enabled_idx').on(table.enabled),
  ],
);

/**
 * One parcel, shared by everyone tracking it — and the poller's work item.
 */
export const trackedParcels = pgTable(
  'tracked_parcels',
  {
    id: generatedId(),
    carrierKey: text()
      .notNull()
      .references(() => trackingCarriers.key, { onDelete: 'restrict' }),
    /** Normalised: `[A-Z0-9]` only. See the CHECK below — it is load-bearing. */
    trackingNumber: text().notNull(),

    status: text().notNull().default('pending'),
    rawStatus: text(),
    serviceName: text(),
    originCountry: text(),
    destinationCountry: text(),
    /** Some carriers require it as a second factor before they will answer. */
    destinationPostalCode: text(),
    estimatedDeliveryAt: timestamptz(),
    deliveredAt: timestamptz(),
    lastCheckpointAt: timestamptz(),
    checkpointCount: integer().notNull().default(0),
    /**
     * How many people are watching. ADVISORY: it drives scheduling, not
     * correctness, and the poller reconciles it against the subscription table
     * periodically. Nothing is denied on the strength of this number.
     */
    subscriberCount: integer().notNull().default(0),

    pollMode: text().notNull().default('poll'),
    /** NULL means "never fetch this again". Terminal, unwatched and deep-link rows all sit here. */
    nextPollAt: timestamptz(),
    lastPolledAt: timestamptz(),
    consecutiveFailures: integer().notNull().default(0),
    /**
     * How many consecutive times the carrier said this number does not exist.
     *
     * Separate from `consecutiveFailures` because a not-found is NOT an error:
     * a label created and never scanned is the single most common thing anyone
     * pastes into a tracker, and treating it as a failure would put it into
     * error backoff forever instead of letting it expire.
     */
    notFoundStreak: integer().notNull().default(0),
    lastPollError: text(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),

    /**
     * The Moovo job this row POINTS AT, when the parcel is one of our own.
     *
     * A pointer, never a copy: such a row carries zero checkpoints for its
     * whole life, and the detail endpoint hydrates the job through
     * `job-hydration.service.ts` instead — live map, courier pings and proof of
     * delivery intact, and `job_status_events` left with exactly one writer.
     * The row exists so that the tracker's list is ONE index scan over
     * subscriptions rather than a union of two sources with two cursors.
     */
    moovoJobId: text().references(() => jobs.id, { onDelete: 'set null' }),

    /**
     * The retention deadline, written by the application on every write.
     *
     * Two policies, one column, because `ExpirySweepTarget` has no predicate
     * field: 30 days once nothing watches this parcel (the number that actually
     * bounds a table anyone can write to by pasting a typo), and 180 days past
     * the terminal event while somebody does. See `trackingRetentionSeconds()`.
     */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('tracked_parcels_status_check', table.status, TRACKING_STATUSES),
    closedSet('tracked_parcels_poll_mode_check', table.pollMode, TRACKING_POLL_MODES),

    /**
     * The deduplication, as a constraint.
     *
     * Everything about the cost of this product is this one index. Two users
     * adding the same number converge on one row, one schedule and one carrier
     * call. A service-layer `findOne` cannot do this: two concurrent adds both
     * miss and both insert.
     */
    uniqueIndex('tracked_parcels_carrier_number_key').on(table.carrierKey, table.trackingNumber),

    /**
     * Normalisation, enforced where it cannot be forgotten.
     *
     * The unique index above is defeated by exactly ONE un-normalised write:
     * `1Z999AA1-0123456784` and `1Z999AA10123456784` become two identities, two
     * schedules and two bills, and no test that merely asserts "the row exists"
     * notices. Every write path funnels through the single exported
     * `normalizeTrackingNumber()`, and this CHECK is what makes forgetting it
     * loud (`23514`) instead of expensive.
     */
    check(
      'tracked_parcels_number_normalised_check',
      sql`${table.trackingNumber} = upper(${table.trackingNumber}) and ${table.trackingNumber} !~ '[^A-Z0-9]'`,
    ),
    /**
     * A carrier we have no way of calling can never be scheduled for a call.
     * Structural rather than conventional: the poller physically cannot pick up
     * a deep-link row, whatever a future caller believes.
     */
    check(
      'tracked_parcels_deeplink_no_poll_check',
      sql`${table.pollMode} <> 'deeplink' or ${table.nextPollAt} is null`,
    ),
    check(
      'tracked_parcels_moovo_job_shape_check',
      sql`${table.moovoJobId} is null or ${table.carrierKey} = 'moovo'`,
    ),
    check(
      'tracked_parcels_poll_error_length_check',
      sql`${table.lastPollError} is null or char_length(${table.lastPollError}) <= ${sql.raw(String(MAX_POLL_ERROR_LENGTH))}`,
    ),

    /**
     * The claim index, PARTIAL on purpose.
     *
     * Terminal, unwatched and deep-link parcels will be the large majority of
     * this table and none of them is ever due. Indexing them would make the
     * poller's index grow with the archive instead of with the backlog.
     */
    index('tracked_parcels_due_idx')
      .on(table.nextPollAt)
      .where(sql`${table.nextPollAt} is not null`),
    index('tracked_parcels_carrier_due_idx')
      .on(table.carrierKey, table.nextPollAt)
      .where(sql`${table.nextPollAt} is not null`),
    index('tracked_parcels_lease_idx')
      .on(table.leaseUntil)
      .where(sql`${table.leaseUntil} is not null`),
    index('tracked_parcels_job_idx')
      .on(table.moovoJobId)
      .where(sql`${table.moovoJobId} is not null`),
    /**
     * The sweep's supporting index. Must be a LEADING btree on the swept
     * column: `@oxyhq/db`'s expiry-coverage gate fails the BUILD without it,
     * and without the gate it would merely be a sequential scan on a timer.
     */
    index('tracked_parcels_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * One scan event on a parcel's journey.
 *
 * Same shape as `job_status_events`, for the same reason: a timeline is read
 * in order and appended to, never updated.
 */
export const trackingCheckpoints = pgTable(
  'tracking_checkpoints',
  {
    id: generatedId(),
    parcelId: text()
      .notNull()
      .references(() => trackedParcels.id, { onDelete: 'cascade' }),
    /**
     * `sha256(occurredAt|rawStatus|locationText|description)`, computed by the
     * application.
     *
     * Carriers re-send the ENTIRE history on every poll and almost none of them
     * issues a stable event id, so without a content hash this table triples on
     * every cycle. Ingest is `ON CONFLICT DO NOTHING RETURNING` — never a raise,
     * because ingest shares a transaction with the parent row's update and a
     * `23505` would abort every statement after it.
     */
    dedupeKey: text().notNull(),
    status: text().notNull(),
    /** The carrier's own words. Kept for diagnostics and for copy we have not mapped. */
    rawStatus: text(),
    description: text(),
    locationText: text(),
    countryCode: text(),
    latitude: latitude(),
    longitude: longitude(),
    location: generatedGeographyPoint('longitude', 'latitude'),
    occurredAt: timestamptz().notNull(),
    /**
     * The carrier reported wall-clock time with no offset, so `occurredAt` is
     * that local time rather than a true instant.
     *
     * Roughly half of carrier APIs do this. Storing a GUESSED UTC silently
     * reorders the timeline the moment a parcel crosses a timezone, and leaves
     * the app unable to tell "05:00 UTC" from "05:00 somewhere". Recording the
     * fact costs a boolean; guessing costs a wrong answer nobody can detect.
     */
    occurredAtIsLocal: boolean().notNull().default(false),
    /** When Moovo learned of it, as distinct from when it happened. */
    receivedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('tracking_checkpoints_status_check', table.status, TRACKING_STATUSES),
    check(
      'tracking_checkpoints_location_shape_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    check(
      'tracking_checkpoints_description_length_check',
      sql`${table.description} is null or char_length(${table.description}) <= ${sql.raw(String(MAX_DESCRIPTION_LENGTH))}`,
    ),
    check(
      'tracking_checkpoints_location_text_length_check',
      sql`${table.locationText} is null or char_length(${table.locationText}) <= ${sql.raw(String(MAX_LOCATION_TEXT_LENGTH))}`,
    ),
    uniqueIndex('tracking_checkpoints_dedupe_key').on(table.parcelId, table.dedupeKey),
    index('tracking_checkpoints_parcel_at_idx').on(table.parcelId, table.occurredAt, table.id),
  ],
);

/**
 * One person watching one parcel.
 *
 * Only ever an Oxy user: **anonymous tracking is a one-off lookup and persists
 * nothing per person.** Without an account there is no row here, no
 * notification, no socket room and nothing to leak — which is also why there is
 * no device identity to hash, no bearer credential to store and no claim
 * ceremony at login. A signed-out user's recent numbers live on their phone.
 *
 * Subscribing is what arms the poller: it is the only thing that gives a parcel
 * a `nextPollAt`.
 */
export const trackedParcelSubscriptions = pgTable(
  'tracked_parcel_subscriptions',
  {
    id: generatedId(),
    parcelId: text()
      .notNull()
      .references(() => trackedParcels.id, { onDelete: 'cascade' }),
    oxyUserId: foreignServiceId().notNull(),
    /**
     * What the user actually typed, before normalisation.
     *
     * Kept so a support conversation can start from the string on their screen
     * rather than from the one the CHECK accepted.
     */
    enteredNumber: text().notNull(),
    /** The user's own label ("zapatillas"), not the carrier's. */
    title: text(),
    notifyOnStateChange: boolean().notNull().default(true),
    archivedAt: timestamptz(),
    lastViewedAt: timestamptz(),
    /**
     * The most recent checkpoint this subscriber was notified about.
     *
     * Per SUBSCRIPTION rather than per parcel, because two people subscribe at
     * different moments: somebody who adds a parcel that is already
     * `out_for_delivery` must not be pushed that event retroactively.
     */
    lastNotifiedCheckpointAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('tracked_parcel_subscriptions_user_parcel_key').on(table.oxyUserId, table.parcelId),
    index('tracked_parcel_subscriptions_user_idx').on(
      table.oxyUserId,
      table.archivedAt,
      table.createdAt,
    ),
    /** The fan-out: everyone to notify when this parcel moves. */
    index('tracked_parcel_subscriptions_parcel_idx').on(table.parcelId),
  ],
);

/**
 * Every webhook delivery a carrier made, and what became of it.
 *
 * Modelled on `moderation_events` field for field, including the part that
 * matters: `id` is a bare `text().primaryKey()` and **not** `generatedId()`,
 * because inserting the row IS the dedupe claim. A generated default would
 * quietly turn two deliveries of one event into two rows with nothing looking
 * wrong.
 *
 * The claim is `ON CONFLICT (id) DO NOTHING RETURNING`: an empty result is the
 * answer "somebody else has this event", never a raised `23505` — which would
 * abort the surrounding transaction and take every later statement with it.
 */
export const trackingWebhookEvents = pgTable(
  'tracking_webhook_events',
  {
    /** The carrier's delivery id, or `sha256(carrierKey|rawBody)` when it sends none. */
    id: text().primaryKey(),
    /**
     * No foreign key, deliberately unlike `tracked_parcels.carrier_key`: this
     * is an audit record of what a carrier sent us, and it must survive that
     * carrier being retired from the catalogue.
     */
    carrierKey: text().notNull(),
    type: text(),
    /** Stored whole as delivered; parsed by the poller, which is the ONE checkpoint writer. */
    payload: jsonb(),
    state: text().notNull().default('claimed'),
    receivedAt: timestamptz().notNull(),
    queuedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('tracking_webhook_events_state_check', table.state, TRACKING_WEBHOOK_STATES),
    index('tracking_webhook_events_carrier_received_idx').on(table.carrierKey, table.receivedAt),
    /** Supports the expiry sweep's predicate — see `db/expiry.ts`. */
    index('tracking_webhook_events_expires_at_idx').on(table.expiresAt),
  ],
);

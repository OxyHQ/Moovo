/**
 * The fleet: courier companies, their members and service areas, and the
 * individual couriers and vehicles that actually fulfil a job.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  closedSet,
  closedSetArray,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
} from './columns';
import {
  COMPANY_PERMISSIONS,
  COMPANY_ROLES,
  COMPANY_STATUSES,
  COURIER_STATUSES,
  CURRENCY_CODES,
  JOB_TYPES,
  ONLINE_STATUSES,
  PAYMENT_PROVIDERS,
  SIZE_CLASSES,
  TEXT_TONES,
  VEHICLE_OWNER_TYPES,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
} from './valueSets';

/**
 * A fleet organization whose members (couriers/dispatchers) fulfil jobs —
 * distinct from an individual courier (`courierProfiles` below), which has no
 * brand and no members. Mirrors `stores` field for field; see its comments
 * for the reasoning behind the shape.
 */
export const courierCompanies = pgTable(
  'courier_companies',
  {
    id: generatedId(),
    handle: text().notNull(),
    name: text().notNull(),
    /** NOT NULL, no database default — see `listings.description`. */
    description: text().notNull(),
    /** An Oxy media file id. Oxy owns identity/media: no FK. */
    logoFileId: foreignServiceId(),
    coverFileId: foreignServiceId(),
    brandColor: text().notNull(),
    textTone: text().notNull().default('light'),
    status: text().notNull().default('active'),
    defaultCurrency: text().notNull().default('USD'),
    /** An AVERAGE, so a float — an integer column would truncate it silently. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    completedJobs: integer().notNull().default(0),
    /**
     * `payout.provider`/`accountRef` flattened — the `stores.policies`
     * device. `accountRef` is the PROVIDER's own reference, so it gets the
     * foreign-service-id helper rather than a bare `text()`.
     */
    payoutProvider: text().notNull().default('oxy_pay'),
    payoutAccountRef: foreignServiceId(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('courier_companies_text_tone_check', table.textTone, TEXT_TONES),
    closedSet('courier_companies_status_check', table.status, COMPANY_STATUSES),
    closedSet('courier_companies_default_currency_check', table.defaultCurrency, CURRENCY_CODES),
    closedSet('courier_companies_payout_provider_check', table.payoutProvider, PAYMENT_PROVIDERS),
    uniqueIndex('courier_companies_handle_key').on(table.handle),
    index('courier_companies_status_created_idx').on(table.status, table.createdAt),
  ],
);

/**
 * `courier_companies.members`, as a CHILD TABLE — the `store_members`
 * reasoning: the source indexes `members.oxyUserId`, so it is queried.
 */
export const companyMembers = pgTable(
  'company_members',
  {
    id: generatedId(),
    companyId: text()
      .notNull()
      .references(() => courierCompanies.id, { onDelete: 'cascade' }),
    /** Oxy owns identity: no FK. */
    oxyUserId: foreignServiceId().notNull(),
    role: text().notNull(),
    permissions: text().array().notNull().default(sql`'{}'::text[]`),
    /** The source's own field name — `joinedBy`, not `invitedBy`. */
    joinedBy: foreignServiceId(),
    joinedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('company_members_role_check', table.role, COMPANY_ROLES),
    closedSetArray('company_members_permissions_check', table.permissions, COMPANY_PERMISSIONS),
    uniqueIndex('company_members_company_oxy_user_key').on(table.companyId, table.oxyUserId),
    index('company_members_oxy_user_idx').on(table.oxyUserId),
  ],
);

/**
 * `courier_companies.serviceAreas` — GeoJSON-center circles describing where
 * a company operates — as a CHILD TABLE, the same shape an embedded array
 * that is queried with its parent gets throughout this schema.
 */
export const companyServiceAreas = pgTable(
  'company_service_areas',
  {
    id: generatedId(),
    companyId: text()
      .notNull()
      .references(() => courierCompanies.id, { onDelete: 'cascade' }),
    latitude: latitude(),
    longitude: longitude(),
    center: generatedGeographyPoint('longitude', 'latitude'),
    radiusM: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * A coordinate pair is both-or-neither — the source never marks either
     * sub-field of `center` required, so the port closes the same hole
     * `listings_location_shape_check` closes for a P2P listing's location.
     */
    check(
      'company_service_areas_center_shape_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    index('company_service_areas_company_idx').on(table.companyId),
    // `courier-company.ts` declares NO 2dsphere index on `serviceAreas.center`
    // — do not add a GiST index here. Nothing in the source queries a service
    // area by proximity; `dispatch.service.ts`'s courier lookup and
    // `search.service.ts` never reach this table.
  ],
);

/**
 * The Moovo-scoped profile of an individual courier ("Glovo mode"), keyed by
 * their Oxy user id. Display name / username / avatar are NEVER stored here —
 * read live from the Oxy profile at hydration time, the `seller_profiles`
 * rule one domain over.
 *
 * `eligibleJobTypes`/`maxWeightKg`/`maxSizeClass` are DENORMALIZED from the
 * active vehicle's own capability — ported as plain columns because that is
 * exactly the cache the source already maintains, not an artifact of the
 * port.
 */
export const courierProfiles = pgTable(
  'courier_profiles',
  {
    id: generatedId(),
    oxyUserId: foreignServiceId().notNull(),
    status: text().notNull().default('pending'),
    onlineStatus: text().notNull().default('offline'),
    /**
     * ABSENT until the courier's first location ping — the `sparse: true`
     * `2dsphere` index, ported. (0, 0) is a real place off the coast of
     * Africa, so "never reported" has to stay a genuine NULL rather than
     * collapsing to a default coordinate.
     */
    latitude: latitude(),
    longitude: longitude(),
    location: generatedGeographyPoint('longitude', 'latitude'),
    lastPingAt: timestamptz(),
    /**
     * `vehicleIds` is DELIBERATELY ABSENT.
     *
     * The source keeps a `vehicleIds` array on the profile and maintains it by
     * hand — `$addToSet` on add and on activate, a `.filter()` on remove. A
     * Postgres array cannot carry a foreign key on its elements, so a deleted
     * vehicle would leave a dangling id there forever, detectable by nothing,
     * and correct only for as long as every future write path remembers to
     * filter it out.
     *
     * It does not need to survive, because it is a cache of a query this
     * database can answer exactly. Both writers admit only vehicles the
     * courier owns: `addVehicle` creates through `createForCourier` (which
     * sets `ownerType:'courier'` and `courierOxyUserId`), and
     * `setActiveVehicle` refuses anything else outright — it throws
     * `forbidden` unless `vehicle.ownerType === 'courier'` AND
     * `vehicle.courierOxyUserId === oxyUserId`. A company-owned vehicle can
     * therefore never enter the array, which is what would have made it a
     * genuine many-to-many needing its own child table.
     *
     * So the array is exactly
     * `select id from vehicles where owner_type = 'courier' and courier_oxy_user_id = $1`
     * — and `listVehicles` ALREADY answers it that way, via
     * `listForCourier(oxyUserId)`, rather than reading the array. The array
     * was a second authority for a fact the first one already owned, and two
     * authorities for one fact can disagree.
     *
     * The single reader that must change when the routes are ported is
     * `courier-profile.controller.ts:51`, which spreads it into a DTO; it
     * derives the list instead.
     */

    /**
     * Points at a row in `vehicles` below. A single Moovo-owned id, so unlike
     * the array above it gets a real foreign key — and `ON DELETE SET NULL` is
     * load-bearing rather than decorative, because `vehicle.service.ts` really
     * does hard-delete vehicles.
     */
    activeVehicleId: text().references((): typeof vehicles.id => vehicles.id, {
      onDelete: 'set null',
    }),
    eligibleJobTypes: text().array().notNull().default(sql`'{}'::text[]`),
    maxWeightKg: doublePrecision().notNull().default(0),
    maxSizeClass: text().notNull().default('small'),
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    completedJobs: integer().notNull().default(0),
    cancelledJobs: integer().notNull().default(0),
    acceptanceRate: doublePrecision(),
    payoutProvider: text().notNull().default('oxy_pay'),
    payoutAccountRef: foreignServiceId(),
    /**
     * The courier's current fleet affiliation — optional and NOT part of any
     * ownership CHECK, so deleting the company only clears the pointer
     * rather than being blocked or orphaning the courier's own profile.
     */
    companyId: text().references(() => courierCompanies.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('courier_profiles_status_check', table.status, COURIER_STATUSES),
    closedSet('courier_profiles_online_status_check', table.onlineStatus, ONLINE_STATUSES),
    closedSetArray(
      'courier_profiles_eligible_job_types_check',
      table.eligibleJobTypes,
      JOB_TYPES,
    ),
    closedSet('courier_profiles_max_size_class_check', table.maxSizeClass, SIZE_CLASSES),
    closedSet('courier_profiles_payout_provider_check', table.payoutProvider, PAYMENT_PROVIDERS),
    check(
      'courier_profiles_location_shape_check',
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),
    uniqueIndex('courier_profiles_oxy_user_key').on(table.oxyUserId),
    /**
     * The `sparse: true` `2dsphere` index: the partial WHERE excludes
     * couriers who have never pinged, exactly as `sparse` excludes a missing
     * field.
     */
    index('courier_profiles_location_idx')
      .using('gist', table.location)
      .where(sql`${table.location} is not null`),
    index('courier_profiles_online_status_last_ping_idx').on(
      table.onlineStatus,
      table.lastPingAt,
    ),
  ],
);

/**
 * A vehicle operated EITHER by an individual courier or by a company.
 *
 * `vehicle.ts`'s `pre('validate')` hook enforced ownership as mutually
 * exclusive — the CONVENTIONS.md rule that such a hook becomes a CHECK and
 * nothing else, the `listings_owner_shape_check` pattern one domain over.
 * `capacity` flattens the same way `stores.policies` does: a value object
 * only ever read and written whole gets plain columns, not jsonb.
 */
export const vehicles = pgTable(
  'vehicles',
  {
    id: generatedId(),
    ownerType: text().notNull(),
    /** Set exactly when `ownerType` is `courier`. Oxy owns identity: no FK. */
    courierOxyUserId: foreignServiceId(),
    /**
     * Set exactly when `ownerType` is `company`. RESTRICT, not the
     * child-table cascade above: a vehicle is a top-level record referencing
     * its company by id (like `listings.storeId` references `stores`), not
     * an embedded array element — and SET NULL would violate the shape CHECK
     * below the instant `ownerType` is `company`.
     */
    companyId: text().references(() => courierCompanies.id, { onDelete: 'restrict' }),
    type: text().notNull(),
    label: text(),
    plate: text(),
    maxWeightKg: doublePrecision().notNull().default(0),
    maxVolumeL: doublePrecision(),
    maxDimsL: doublePrecision(),
    maxDimsW: doublePrecision(),
    maxDimsH: doublePrecision(),
    eligibleJobTypes: text().array().notNull().default(sql`'{}'::text[]`),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('vehicles_owner_type_check', table.ownerType, VEHICLE_OWNER_TYPES),
    closedSet('vehicles_type_check', table.type, VEHICLE_TYPES),
    closedSet('vehicles_status_check', table.status, VEHICLE_STATUSES),
    closedSetArray('vehicles_eligible_job_types_check', table.eligibleJobTypes, JOB_TYPES),
    /** `vehicle.ts`'s `pre('validate')` hook, as the database states it. */
    check(
      'vehicles_owner_shape_check',
      sql`(${table.ownerType} = 'courier' and ${table.courierOxyUserId} is not null and ${table.companyId} is null)
       or (${table.ownerType} = 'company' and ${table.companyId} is not null and ${table.courierOxyUserId} is null)`,
    ),
    index('vehicles_courier_oxy_user_idx').on(table.courierOxyUserId),
    index('vehicles_company_idx').on(table.companyId),
  ],
);

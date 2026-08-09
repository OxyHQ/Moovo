/**
 * Schema-wide conventions, asserted against the DDL that actually landed.
 *
 * These are rules a single table can break on its own without anything else
 * noticing, so they are checked across every table at once, and against the
 * real catalogue rather than the TypeScript that was meant to produce it.
 *
 * Every gate carries a VACUITY FLOOR, because the dangerous failure here is a
 * traversal that returns nothing and passes by examining nothing —
 * `expect([]).toEqual([])` is exactly what a broken scan produces.
 */

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findIdColumnViolations, findSchemaInvariantViolations } from '@oxyhq/db/assert';
import { is } from 'drizzle-orm';
import { Table } from 'drizzle-orm';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';
import { getDb } from '../postgres';
import * as schema from '../schema';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/**
 * Every TABLE the barrel exports.
 *
 * Widened to `unknown` before filtering because the barrel also exports two
 * SEQUENCEs, so its value union is not homogeneous — and a filter typed
 * against that union narrows to the wrong thing.
 */
const TABLES: PgTable[] = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => is(value, Table),
);

/**
 * The table count, pinned.
 *
 * 26 Mongoose models become 25 tables (`counters` becomes two SEQUENCEs, which
 * is what Postgres has and what that collection was emulating), plus 9 child
 * tables for embedded arrays that are queried, updated per element, or both.
 *
 * Pinned rather than derived because the barrel is the thing that decides
 * whether a table is migrated at all: a table defined but never exported
 * produces no migration, and the omission looks exactly like "no schema change
 * to generate".
 */
const EXPECTED_TABLE_COUNT = 34;

/**
 * Traversal floors. Deliberately well below the real figures — they exist to
 * catch a query returning nothing, not to be re-tuned on every schema change.
 */
const MINIMUM_TABLES = 30;
const MINIMUM_COLUMNS = 400;

/**
 * `*_id` columns that will NEVER carry a foreign key, each with its reason.
 *
 * Between real `.references()` calls and this ledger, every id-shaped column
 * is accounted for. One that is in neither is a column nobody has decided
 * about — which is what the gate reports, so that "no constraint" and "nobody
 * has looked at this yet" stop being indistinguishable.
 */
const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [
  // Oxy owns identity. Moovo owns none of these rows and cannot enforce their
  // existence; a foreign key would either fail on a legitimate write or
  // require mirroring another service's table.
  { column: 'listings.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'orders.buyer_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'orders.seller_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'addresses.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'carts.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'reviews.author_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'reviews.seller_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'feedback.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'push_tokens.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'web_push_subscriptions.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'notifications.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'seller_profiles.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'courier_profiles.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'store_members.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'company_members.oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'shipments.sender_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'jobs.sender_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'jobs.courier_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'job_offers.courier_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'job_status_events.by_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'order_status_events.by_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'vehicles.courier_oxy_user_id', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'store_members.invited_by', reason: 'Oxy user id — Oxy owns identity.' },
  { column: 'company_members.joined_by', reason: 'Oxy user id — Oxy owns identity.' },

  // Oxy media file ids — another service's key space.
  { column: 'categories.image_file_id', reason: 'Oxy media file id.' },
  { column: 'stores.logo_file_id', reason: 'Oxy media file id.' },
  { column: 'stores.cover_file_id', reason: 'Oxy media file id.' },
  { column: 'courier_companies.logo_file_id', reason: 'Oxy media file id.' },
  { column: 'courier_companies.cover_file_id', reason: 'Oxy media file id.' },
  { column: 'providers.logo_file_id', reason: 'Oxy media file id.' },
  { column: 'jobs.pod_photo_file_id', reason: 'Oxy media file id.' },
  { column: 'jobs.pod_signature_file_id', reason: 'Oxy media file id.' },

  // CrowdSource's key space.
  { column: 'reports.crowd_source_report_id', reason: 'CrowdSource id — their key space.' },
  { column: 'reports.crowd_source_case_id', reason: 'CrowdSource id — their key space.' },
  { column: 'moderation_events.case_id', reason: 'CrowdSource id — their key space.' },
  { column: 'moderation_enforcements.case_id', reason: 'CrowdSource id — their key space.' },
  { column: 'moderation_enforcements.decision_id', reason: 'CrowdSource id — their key space.' },

  // Polymorphic: the parent table is decided by a sibling column, so no single
  // table can be referenced.
  {
    column: 'reports.reported_id',
    reason: 'Polymorphic by `reported_type` — an Oxy user id, a job id or a listing id.',
  },
  {
    column: 'moderation_enforcements.target_id',
    reason: 'Polymorphic by `target_type` — an Oxy user id or a job id.',
  },

  // Immutable snapshots. A line item must survive the listing being deleted:
  // an order is a record of what was bought, not a view onto a live catalogue.
  {
    column: 'order_items.listing_id',
    reason: 'Frozen snapshot — must survive deletion of the listing it was copied from.',
  },
  {
    column: 'order_items.variant_id',
    reason: 'Frozen snapshot — must survive deletion of the variant it was copied from.',
  },

  // Circular with `jobs.shipment_id`. The pair is written in one transaction
  // and a cycle of NOT NULL foreign keys would make either insert unsatisfiable
  // without deferred constraints.
  {
    column: 'shipments.job_id',
    reason: 'Circular with jobs.shipment_id, which is the authoritative direction.',
  },

  // A `Trigger` collection does not exist anywhere in this codebase — the
  // source's only mongoose `ref`, and it dangles. `notification-service.ts`
  // writes it, so the column stays; there is simply no table to point at.
  { column: 'notifications.trigger_id', reason: 'No `triggers` table exists — a dangling ref.' },

  // Ids that name something which is not a row in any table.
  {
    column: 'orders.checkout_group_id',
    reason:
      'Groups the orders one checkout split into. There is no `checkout_groups` ' +
      'table and should not be — the group IS the set of orders sharing the value.',
  },
  {
    column: 'push_tokens.device_id',
    reason: "The client device's own id, minted on the device. Moovo stores no devices.",
  },
  {
    column: 'notifications.conversation_id',
    reason:
      'Names a conversation in another Oxy application; Moovo has no conversations.',
  },

  // No `locations` table exists yet; the multi-location seam is unused in F1.
  {
    column: 'inventory_levels.location_id',
    reason: 'The multi-location seam is defined but unused — no `locations` table yet.',
  },
];

describeIfPostgres('the migrated schema', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('exports every table it defines', () => {
    expect(TABLES).toHaveLength(EXPECTED_TABLE_COUNT);
  });

  it('breaks no schema-wide convention', async () => {
    // snake_case names, `timestamptz` everywhere, a primary key on every table,
    // no `_id`/`__v` mongoose artefacts, no empty-string defaults — plus the
    // vacuity floors, folded into the same violation list so a single
    // assertion cannot pass by examining nothing.
    const violations = await findSchemaInvariantViolations(getDb(), {
      minimumTables: MINIMUM_TABLES,
      minimumColumns: MINIMUM_COLUMNS,
    });
    expect(violations).toEqual([]);
  });

  it('has a decision recorded for every id-shaped column', async () => {
    const violations = findIdColumnViolations({
      tables: TABLES,
      // Nothing is deferred: every parent table this schema references lands in
      // the same migration. An entry here would mean a foreign key that is
      // decided but not yet expressible.
      deferred: [],
      withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY,
      minimumTables: MINIMUM_TABLES,
    });
    expect(violations).toEqual([]);
  });

  it('uses CHECK constraints rather than pg enum types', async () => {
    // A pg enum cannot gain a value in the same transaction as the code using
    // it, and cannot lose one at all. The whole schema is `text` + CHECK, so
    // there should be no enum type in this database whatsoever.
    const rows = await suite!.client<{ typname: string }[]>`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public'
    `;
    expect(rows).toEqual([]);
  });

  it('carries a CHECK for every closed-set column', async () => {
    // A floor rather than an exact count: the point is that the constraints
    // really landed in the database, not merely that the helper was called.
    const [row] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_constraint
      WHERE contype = 'c' AND connamespace = 'public'::regnamespace
    `;
    expect(row?.count).toBeGreaterThan(50);
  });

  it('names every table in the barrel exactly once', () => {
    // `export *` from nine modules would silently drop a table if two modules
    // exported the same name — the second would win and the first would vanish
    // from the migration with no error.
    const names = TABLES.map((table) => getTableConfig(table).name);
    expect(new Set(names).size).toBe(names.length);
  });
});

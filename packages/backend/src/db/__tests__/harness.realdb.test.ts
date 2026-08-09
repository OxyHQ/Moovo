import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as runMigrateEntrypoint } from '../migrate';
import { getDb } from '../postgres';
import {
  POSTGRES_TESTS_ENABLED,
  POSTGRES_TESTS_REQUIRED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

/**
 * The Postgres pipeline, proven end to end before any schema depends on it.
 *
 * This exists because the alternative is landing the first domain table and the
 * harness together — and then a red suite has two candidate causes, the table
 * and the machinery, with neither ruled out. Everything here is about the
 * machinery: a database is created, `db/migrate.ts` is the thing that migrates
 * it, `getDb()` resolves to THAT database, and it is dropped afterwards.
 *
 * The schema is deliberately empty at this commit. That rules out asserting on
 * rows OR on drizzle's ledger — with an empty journal no ledger table is
 * created — so the evidence that the migrator really ran is its own
 * target-database guard firing against a real connection.
 *
 * BOTH KNOWN GAPS ARE NOW CLOSED, by the first migration (`0000`).
 *
 * They are recorded here rather than deleted, because the mutations that prove
 * them closed are the maintenance instructions for this file.
 *
 * GAP 1 — "does the harness actually call the migrator?" Previously
 * unanswerable: with an empty journal there was no DDL whose absence could be
 * observed, so making `testDatabase.ts` skip the migration call entirely still
 * passed every test. Now closed by `it('applied the first migration')` below,
 * which asserts a real table exists. RE-MEASURED after `0000` landed: deleting
 * the `runMigrateEntrypoint(...)` call from `testDatabase.ts` fails that test
 * (`relation "listings" does not exist`), where before it failed nothing.
 *
 * GAP 2 — "is PostGIS really there?" Previously it was NOT created in these
 * throwaway databases at all: `runMigrations` returns on an empty journal
 * BEFORE reaching `ensureExtensions`, so `pg_extension` had no row for it.
 * With a migration pending that short-circuit no longer applies, extensions
 * are ensured BEFORE the DDL naming `geography`, and the assertion below
 * measures the extension rather than assuming the order. Verified against the
 * real server: `postgis` 3.5.2 is present in a freshly migrated database.
 */

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

// In CI this must RUN, not skip. Expressed as a failing test rather than a
// grep over reporter output, so it cannot be defeated by a formatting change.
describe('the real-database suites', () => {
  it('are available wherever they are required', () => {
    if (POSTGRES_TESTS_REQUIRED && !POSTGRES_TESTS_ENABLED) {
      throw new Error(
        'MOOVO_REQUIRE_POSTGRES_TESTS=1 but TEST_DATABASE_URL is unset, so the ' +
          'Postgres suites would SKIP. In CI that is a green build over an ' +
          'untested database — start the compose server and export the URL.',
      );
    }
    expect(POSTGRES_TESTS_REQUIRED && !POSTGRES_TESTS_ENABLED).toBe(false);
  });
});

describeIfPostgres('the Postgres test harness', () => {
  let suite: SuiteDatabase | null = null;

  /**
   * The state of the database AS THE HARNESS HANDED IT OVER, captured before
   * any test in this file has run.
   *
   * This indirection is load-bearing, and it was added because the mutation
   * caught it: `it('migrates cleanly when the target matches')` below calls
   * the migrator ITSELF, so a later assertion that "the schema exists" is
   * satisfied by that test's side effect rather than by the harness. With the
   * migration call deleted from `testDatabase.ts` the suite still passed —
   * the same false green the gap was supposed to close, one step further on.
   *
   * Capturing in `beforeAll` makes the assertion independent of what any other
   * test does, and of the order they run in.
   */
  let schemaAtSetup: { hasListings: boolean; ledgerRows: number; postgis: string | null } | null =
    null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();

    const [listings] = await suite.client<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'listings'
      ) AS exists
    `;
    const [ledger] = await suite.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `.catch(() => [{ count: 0 }]);
    const [extension] = await suite.client<{ extversion: string }[]>`
      SELECT extversion FROM pg_extension WHERE extname = 'postgis'
    `;

    schemaAtSetup = {
      hasListings: listings?.exists ?? false,
      ledgerRows: ledger?.count ?? 0,
      postgis: extension?.extversion ?? null,
    };
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('creates a throwaway database, not the admin one it was pointed at', async () => {
    const name = new URL(suite!.databaseUrl).pathname.slice(1);
    // The prefix is `@oxyhq/db`'s, and the check matters: `TEST_DATABASE_URL`
    // names the ADMIN database, so a harness that failed to create anything
    // would hand back a working handle to `postgres` and every suite would
    // quietly share one database.
    expect(name).toMatch(/^oxydb_test_[0-9a-f]{16}$/);

    const [row] = await suite!.client<{ current: string }[]>`SELECT current_database() AS current`;
    expect(row?.current).toBe(name);
  });

  it('ran the real migrator against this database — proven by its own guard firing', async () => {
    // MEASURED, not assumed: with an EMPTY journal drizzle creates no ledger
    // table at all, so `drizzle.__drizzle_migrations` cannot be the evidence
    // here (it does not exist until the first migration lands). That left the
    // harness able to assert only "a database exists" — which plain CREATE
    // DATABASE satisfies, and which therefore cannot tell a working migrator
    // from one that silently did nothing.
    //
    // So the evidence is the migrator's OWN target-database guard: pointed at
    // this real database while claiming a different one, it must refuse. That
    // can only happen if the entrypoint connected and compared, which is
    // precisely the thing a no-op would not do.
    await expect(
      runMigrateEntrypoint(
        ['--target-database=definitely_not_this_database', '--phase=all'],
        { ...process.env, DATABASE_URL: suite!.databaseUrl },
      ),
    ).rejects.toThrow(
      // Pinned to a message only the guard produces, naming BOTH the expected
      // and the reached database. A looser pattern — anything matching
      // /database/i — would also be satisfied by a connection failure, and then
      // this test would pass on a server that was never reachable at all.
      /Refusing to migrate: the run expects "definitely_not_this_database" but .* reaches "oxydb_test_[0-9a-f]{16}"/s,
    );
  });

  it('migrates cleanly when the target matches — and is safe to re-run', async () => {
    // Idempotence is the property the deploy depends on: the one-shot task runs
    // on every release, and a second run over an already-migrated database must
    // be a no-op rather than an error.
    const name = new URL(suite!.databaseUrl).pathname.slice(1);
    await expect(
      runMigrateEntrypoint([`--target-database=${name}`, '--phase=all'], {
        ...process.env,
        DATABASE_URL: suite!.databaseUrl,
      }),
    ).resolves.toBeUndefined();
  });

  it('applied the first migration — which is what proves the harness migrates at all', async () => {
    // GAP 1, closed. Before `0000` existed this assertion had no subject: an
    // empty journal creates no DDL and no ledger table, so a harness that
    // skipped the migration entirely produced a database indistinguishable
    // from one that ran it.
    //
    // `listings` is a good witness because it is created by `0000` and by
    // nothing else — not by `CREATE DATABASE`, not by PostGIS, not by drizzle's
    // own bookkeeping (which lives in the `drizzle` schema, not `public`).
    //
    // Read from the SETUP snapshot, never live: see `schemaAtSetup`.
    expect(schemaAtSetup?.hasListings).toBe(true);

    // And the ledger now exists too, which it could not before.
    expect(schemaAtSetup?.ledgerRows).toBeGreaterThan(0);
  });

  it('created the PostGIS extension the schema depends on', async () => {
    // GAP 2, closed. `runMigrations` returns on an empty journal BEFORE it
    // reaches `ensureExtensions`, so with no migrations this row did not
    // exist — measured, not assumed. With `0000` pending, extensions are
    // ensured first, which they must be: `0000` names `geography` in nine
    // generated columns and would fail outright without them.
    expect(schemaAtSetup?.postgis).toBeTruthy();

    // The type is not merely declared but USABLE — an extension row with a
    // broken install would still satisfy the query above.
    const [point] = await suite!.client<{ srid: number }[]>`
      SELECT ST_SRID(ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography) AS srid
    `;
    expect(point?.srid).toBe(4326);
  });

  it('points getDb() at the throwaway database', async () => {
    // Repositories call `getDb()` themselves rather than taking an injected
    // handle, so if the harness did not repoint the module-level handle they
    // would open a SECOND connection — to whatever `DATABASE_URL` names, which
    // in CI is nothing and locally is a developer's own data.
    const [row] = await getDb().execute<{ current: string }>(
      sql`SELECT current_database() AS current`,
    );
    expect(row?.current).toBe(new URL(suite!.databaseUrl).pathname.slice(1));
  });
});

/**
 * The migrator's refusals. Pure argument handling — no database, so these run
 * everywhere, including where Postgres is unavailable.
 */
describe('db/migrate refuses to guess', () => {
  it('refuses without --target-database', async () => {
    // The failure this prevents is silent: a migrator pointed at the wrong
    // database finds an empty ledger, applies the whole journal and exits 0,
    // over a database belonging to another Oxy app on the same shared server.
    await expect(
      runMigrateEntrypoint(['--phase=all'], { DATABASE_URL: 'postgres://x/y' }),
    ).rejects.toThrow(/target-database/i);
  });

  it('refuses without --phase', async () => {
    await expect(
      runMigrateEntrypoint(['--target-database=moovo'], { DATABASE_URL: 'postgres://x/y' }),
    ).rejects.toThrow(/phase/i);
  });

  it('refuses an unknown --phase rather than treating it as the default', async () => {
    await expect(
      runMigrateEntrypoint(['--target-database=moovo', '--phase=sometimes'], {
        DATABASE_URL: 'postgres://x/y',
      }),
    ).rejects.toThrow(/sometimes/);
  });

  it('refuses without DATABASE_URL', async () => {
    await expect(
      runMigrateEntrypoint(['--target-database=moovo', '--phase=all'], {}),
    ).rejects.toThrow(/DATABASE_URL/);
  });
});

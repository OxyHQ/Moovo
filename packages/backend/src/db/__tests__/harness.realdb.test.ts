import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as runMigrateEntrypoint } from '../migrate';
import { getDb } from '../postgres';
import {
  POSTGRES_TESTS_ENABLED,
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
 * KNOWN GAP, stated rather than left to be discovered. Mutation-tested: making
 * `testDatabase.ts` skip the migration call entirely still passes every test
 * here. It has to — with an empty journal there is no DDL whose absence could
 * be observed, so "migrated" and "did not migrate" produce identical databases.
 *
 * The gap closes the moment the FIRST migration lands, and closing it is part
 * of that change, not a follow-up: assert the table it creates exists, and
 * re-run this same mutation to confirm skipping the migration now fails.
 * Until then this suite proves the migrator ENTRYPOINT is correct (its guards
 * fire, it is idempotent) but not that the harness calls it.
 */

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

describeIfPostgres('the Postgres test harness', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
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

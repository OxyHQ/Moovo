import { createDatabase } from '@oxyhq/db';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';
import type postgres from 'postgres';
import { main as runMigrateEntrypoint } from './migrate';
import { setDatabaseForTesting, type Database } from './postgres';
import * as schema from './schema';

/**
 * A throwaway, fully migrated database for ONE test file.
 *
 * Per file rather than per run: a database shared across files makes every
 * suite's rows visible to every other suite, and the contention that produces
 * — `too many clients already`, and rows one file deleted that another was
 * counting — reads exactly like a regression in the code under test. That
 * misattribution is the expensive failure, not the few hundred milliseconds a
 * fresh database costs.
 *
 * The migration runs through `db/migrate.ts`'s own `main`, NOT a second
 * composition of `runMigrations`. A harness that assembles its own migration
 * call drifts from the entrypoint production uses, and then the suite is
 * testing a schema no deployment ever gets.
 */

/**
 * Where throwaway databases are created — the ADMIN database, not one any suite
 * connects to. No default: a guessed local server would create databases
 * somewhere nobody intended, and on this machine every Oxy app keeps its own
 * server, so a guess would likely land on another product's.
 */
export const TEST_ADMIN_URL_ENV = 'TEST_DATABASE_URL';

export const TEST_ADMIN_URL = process.env[TEST_ADMIN_URL_ENV];

/** Whether the real-database suites can run at all in this environment. */
export const POSTGRES_TESTS_ENABLED = Boolean(TEST_ADMIN_URL);

/**
 * Whether this environment REQUIRES them to run — set in CI.
 *
 * Skipping is right on a laptop with no container up, and wrong in CI, where a
 * skipped suite and a passing suite are the same colour: a container that
 * failed to start or a renamed variable would leave the build green while
 * nothing was tested against a database.
 *
 * This lives here rather than as a grep over the runner's output in the
 * workflow, which is where it started. That version could not work: vitest's
 * default reporter prints a per-file line only for FAILING files, so a grep for
 * the harness file finds nothing precisely when everything passed — the gate
 * failed every green run. A check whose correctness depends on a reporter's
 * formatting is the wrong shape; the suite asserting its own prerequisite is
 * not.
 */
export const POSTGRES_TESTS_REQUIRED_ENV = 'MOOVO_REQUIRE_POSTGRES_TESTS';

/**
 * The ONE value that arms the requirement.
 *
 * Exported beside the name because the gate in `db/__tests__/deployWorkflow.test.ts`
 * has to assert the workflow sets it to a value this comparison accepts. A
 * plausible near-miss — `MOOVO_REQUIRE_POSTGRES_TESTS: 'true'` — reads to a
 * human as "required", disarms the check completely, and fails nothing: the
 * suites go back to skipping and the deploy goes back to green over them.
 */
export const POSTGRES_TESTS_REQUIRED_VALUE = '1';

export const POSTGRES_TESTS_REQUIRED =
  process.env[POSTGRES_TESTS_REQUIRED_ENV] === POSTGRES_TESTS_REQUIRED_VALUE;

export interface SuiteDatabase {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly databaseUrl: string;
}

export async function createSuiteDatabase(): Promise<SuiteDatabase> {
  if (!TEST_ADMIN_URL) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local server with ' +
        '`docker compose -f docker-compose.postgres.yml up -d --wait` and export ' +
        'TEST_DATABASE_URL=postgres://moovo:moovo@127.0.0.1:5437/postgres',
    );
  }

  const databaseUrl = await createTestDatabase({
    adminUrl: TEST_ADMIN_URL,
    migrate: async (url) => {
      // `all` is correct for a fresh database: `pre` and `post` describe the two
      // sides of a rolling deploy, and a database created a moment ago has no
      // previous image to stay compatible with.
      const name = new URL(url).pathname.slice(1);
      await runMigrateEntrypoint(
        [`--target-database=${name}`, '--phase=all'],
        { ...process.env, DATABASE_URL: url },
      );
    },
  });

  const { db, client } = createDatabase({ databaseUrl, schema });
  setDatabaseForTesting({ db, client });
  return { db, client, databaseUrl };
}

/** Close the handle and drop the database. Safe to call after a failed setup. */
export async function destroySuiteDatabase(suite: SuiteDatabase | null): Promise<void> {
  if (!suite) return;
  setDatabaseForTesting(null);
  await suite.client.end({ timeout: 5 });
  await dropTestDatabase(suite.databaseUrl);
}

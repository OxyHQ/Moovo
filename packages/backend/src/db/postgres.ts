import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from './schema';

/** The drizzle handle over this service's own schema. */
export type Database = OxyDatabase<typeof schema>;

/** The handle drizzle hands a `db.transaction(cb)` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What every repository function takes as its first argument.
 *
 * A repository that declares `Database` cannot be called inside a transaction,
 * and one that reaches for the module-level handle ITSELF cannot be called
 * inside a transaction either — it would silently open a second connection and
 * commit outside the caller's block, which type-checks perfectly and loses
 * atomicity. Taking the union is what keeps both possible, and is why the type
 * lives here rather than being respelled per module.
 */
export type DatabaseOrTransaction = Database | Transaction;

/**
 * Pool ceiling. One task serving several concurrent requests, against an RDS
 * instance shared with every other Oxy app — an unbounded pool here is a
 * connection shortage for somebody else's service.
 */
const MAX_POOL_CONNECTIONS = 10;

let handle: { db: Database; client: postgres.Sql } | null = null;

/**
 * The process-wide handle, opened on first use.
 *
 * Lazy rather than at import: a module that connects on import makes every
 * unit test that transitively imports it need a database.
 */
export function getDb(): Database {
  return connect().db;
}

/** The raw client, for the few things drizzle does not express. */
export function getClient(): postgres.Sql {
  return connect().client;
}

function connect(): { db: Database; client: postgres.Sql } {
  if (handle) return handle;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing here rather than defaulting to a local server: a default makes a
    // misconfigured task boot, report healthy-ish and fail every request, which
    // is strictly harder to diagnose than not starting.
    throw new Error('DATABASE_URL is not set, so this service has no database to open.');
  }

  handle = createDatabase({
    databaseUrl,
    schema,
    client: { max: MAX_POOL_CONNECTIONS },
  });
  return handle;
}

/**
 * Point the module-level handle at a database the caller owns.
 *
 * Exists for the test harness, which creates a throwaway database per file and
 * needs `getDb()` to resolve to it — so repositories that call `getDb()`
 * themselves work unchanged under test, with no dependency injection threaded
 * through every call site purely for testing.
 */
export function setDatabaseForTesting(next: { db: Database; client: postgres.Sql } | null): void {
  handle = next;
}

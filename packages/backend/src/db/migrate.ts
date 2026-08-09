import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_RUNS,
  type MigrationRun,
  type RequiredExtension,
  readTargetDatabase,
  runMigrations,
} from '@oxyhq/db/migrate';

/**
 * The ONLY thing that applies migrations to a Moovo database.
 *
 * Run locally as `bun run db:migrate -- --target-database=<name> --phase=<run>`
 * and in production as a one-shot task before the service rolls.
 * `drizzle-kit migrate` is NOT an alternative: it is a devDependency and never
 * reaches the production image, so a deploy relying on it applies nothing and
 * reports success.
 */

/**
 * Extensions this schema depends on.
 *
 * MEASURED against the source, not assumed — and the first draft of this file
 * asserted "NONE", which was wrong. Moovo declares four `2dsphere` indexes
 * (courier `currentLocation`, listing `location`, shipment `pickup.location`
 * and `dropoff.location`) and, more decisively, RUNS geo queries:
 * `dispatch.service.ts` finds couriers with `$nearSphere` — that is courier
 * dispatch, the core of the product — and `search.service.ts` uses `$near`.
 *
 * Those become a `geography` column with a GiST index, which needs PostGIS.
 *
 * The `text` index on listings (`title`/`description`/`tags`) does NOT need an
 * extension: Postgres full-text search is built in (`tsvector` + GIN).
 *
 * PostGIS is a PRIVILEGED prerequisite, not something this migrator can create.
 * `CREATE EXTENSION postgis` fails with `permission denied` even for the role
 * that OWNS the database — it is not a trusted extension — so it is installed
 * once per database by the RDS master user BEFORE any migration references the
 * type. Declaring it here is what makes a missing install fail loudly and
 * early, rather than at the first migration that names `geography`.
 *
 * A `CREATE EXTENSION IF NOT EXISTS` inside a migration is NOT an alternative:
 * it short-circuits on the exists check before the privilege check, so it is a
 * silent no-op where the extension is present and a hard failure where it is
 * not — protection in appearance only.
 */
const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      'Courier dispatch and listing search answer "near this point" queries — ' +
      '`$nearSphere` in dispatch.service.ts and `$near` in search.service.ts — ' +
      'which become a geography column with a GiST index.',
  },
];

/**
 * Where the generated SQL lives.
 *
 * Under `src/` deliberately: the image runs TypeScript directly and copies
 * `packages/backend/src/` wholesale, so migrations anywhere else would have to
 * be remembered separately in the Dockerfile — and being forgotten there fails
 * at deploy time rather than at build time.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function readRun(argv: readonly string[]): MigrationRun {
  const flag = argv.find((argument) => argument.startsWith('--phase='));
  const value = flag?.slice('--phase='.length);
  if (value === undefined) {
    throw new Error(
      `Refusing to migrate: no --phase=<${MIGRATION_RUNS.join('|')}>. ` +
        '`pre` applies additive migrations while the previous image is still serving; ' +
        '`post` applies drops, renames and narrowings once the new image is live; ' +
        '`all` applies the whole chain in one run and is for a from-zero genesis or a ' +
        'cutover batch, never a normal release.',
    );
  }
  if (!MIGRATION_RUNS.includes(value as MigrationRun)) {
    throw new Error(
      `Refusing to migrate: --phase=${JSON.stringify(value)} is not one of ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Refusing to migrate: DATABASE_URL is not set.');
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: REQUIRED_EXTENSIONS,
    run: readRun(argv),
    // `expectedDatabase` is what makes a mistyped DATABASE_URL fail LOUDLY.
    // Without it a migrator pointed at the wrong database does not error: it
    // finds an empty ledger, applies the whole journal, prints a success line
    // and exits 0 — over a database belonging to another Oxy app on the same
    // shared server.
    expectedDatabase: readTargetDatabase(argv),
    dryRun: argv.includes('--dry-run'),
    logger: {
      info: (message) => {
        process.stdout.write(`${message}\n`);
      },
      debug: (message) => {
        process.stdout.write(`${message}\n`);
      },
    },
  });
}

// `import.meta.main` is true only when this file is the entrypoint, so the test
// harness can import `main` without triggering a migration.
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

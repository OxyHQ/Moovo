import { DATABASE_CASING } from '@oxyhq/db';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit's half of the schema: it GENERATES the SQL that `db/migrate.ts`
 * later applies. It never applies anything — `drizzle-kit migrate` is a
 * devDependency command that cannot reach the production image.
 *
 * `casing` is read from `@oxyhq/db` rather than spelled out, because one
 * setting decides both the column names the runtime handle REFERENCES
 * (`db/postgres.ts`) and the column names these migrations CREATE. Two copies
 * of that decision produce queries against columns that do not exist.
 *
 * Migrations live under `src/` because the image runs TypeScript directly and
 * copies `packages/backend/src/` wholesale — anywhere else would have to be
 * remembered in the Dockerfile, and being forgotten there fails at deploy time.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  casing: DATABASE_CASING,
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});

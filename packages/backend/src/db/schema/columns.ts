/**
 * The column shapes this schema repeats, defined once.
 *
 * `@oxyhq/db` owns the ecosystem-wide ones (`generatedId`, `createdAt`,
 * `updatedAt`, `timestamptz`, `geography`, `tsvector`, `inList`). What lives
 * here is the handful that are Moovo's own — money, geographic points and the
 * closed-set CHECK — because each encodes a decision a hand-written column
 * could silently get wrong.
 */

import { sql, type SQL } from 'drizzle-orm';
import { bigint, check, doublePrecision, text } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { geography, inList } from '@oxyhq/db';

/**
 * A money AMOUNT: integer minor units, never a float.
 *
 * `bigint({ mode: 'number' })` rather than `numeric`: every amount in the
 * source is already an integer minor unit (`Money.amount` is cents,
 * `FairMoney.fairMinor` is FAIR minor units), and `numeric` would come back
 * from the driver as a string and invite float arithmetic at the call sites
 * that currently do integer arithmetic. `mode: 'number'` re-imposes the JS
 * safe-integer ceiling at the storage layer, which is the same bound the
 * application already lives under.
 */
export const moneyMinor = () => bigint({ mode: 'number' });

/**
 * A latitude/longitude pair, stored as the two ordinates the application
 * actually reads and writes.
 *
 * The `geography` column beside them is GENERATED from this pair (see
 * {@link generatedGeographyPoint}) rather than written directly, so there is
 * exactly one source of truth for a position and no way for the point and its
 * ordinates to disagree.
 */
export const latitude = () => doublePrecision();
export const longitude = () => doublePrecision();

/**
 * The PostGIS point, GENERATED from a longitude/latitude column pair.
 *
 * The ordinate order is the one place GeoJSON and PostGIS agree and the
 * easiest to get backwards: GeoJSON stores `[lng, lat]` and `ST_MakePoint`
 * takes `(lng, lat)`. Getting it wrong does not fail — it silently puts every
 * courier in the wrong hemisphere, which is why the ordering is asserted
 * against a real measured distance in `geo.realdb.test.ts` rather than trusted
 * to a code comment.
 *
 * The column names are spelled out as SQL identifiers because a generated
 * expression has no drizzle `Column` object to interpolate — this is the one
 * sanctioned exception to "never spell the casing out", and it is why the
 * helper takes the SQL names explicitly instead of guessing them.
 *
 * `ST_MakePoint` is STRICT, so a row with a NULL ordinate generates a NULL
 * point — which is what makes a nullable location genuinely absent ("this
 * courier has not reported a position") rather than a point at (0, 0) in the
 * Gulf of Guinea.
 */
export const generatedGeographyPoint = (longitudeColumn: string, latitudeColumn: string) =>
  geography().generatedAlwaysAs(
    (): SQL =>
      sql.raw(
        `ST_SetSRID(ST_MakePoint(${longitudeColumn}, ${latitudeColumn}), 4326)::geography`,
      ),
  );

/**
 * A CHECK restricting a `text` column to a closed set — the schema's only way
 * of expressing an enum.
 *
 * A PostgreSQL `enum` type is deliberately not used: adding a value to one is
 * DDL that cannot run in the same transaction as the code using it, and
 * removing a value is not supported at all. A CHECK is an ordinary migration.
 *
 * Both arguments come from the SAME `as const` tuple that types the column, so
 * the TypeScript union and the constraint cannot drift apart.
 */
export const closedSet = (name: string, column: PgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(inList(values))})`);

/**
 * A CHECK restricting a `text[]` column to elements drawn from a closed set.
 *
 * Containment (`<@`) is trivially satisfied by an empty array, which is the
 * correct reading: an empty `permissions` or `tags` list breaks no rule.
 */
export const closedSetArray = (name: string, column: PgColumn, values: readonly string[]) =>
  check(name, sql`${column} <@ array[${sql.raw(inList(values))}]::text[]`);

/**
 * An id belonging to a FOREIGN service — an Oxy user id, an Oxy media file id,
 * a provider's own reference.
 *
 * A distinct helper rather than a bare `text()` so that "this carries no
 * foreign key on purpose" is visible at the column rather than inferred from
 * the absence of a `.references()`. Oxy owns identity; Moovo owns none of
 * those rows and cannot enforce their existence.
 */
export const foreignServiceId = () => text();

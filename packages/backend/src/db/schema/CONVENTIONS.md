# Moovo schema conventions

The binding ledger for this port. Read it before touching `db/schema/`.

Decisions live here rather than in commit messages because a decision nobody can
find gets remade differently, and the second version is the one that produces a
bug. Where a rule exists to prevent a specific failure, the failure is named —
a rule whose reason is missing is a rule the next person relaxes.

## PostgreSQL, and what the database is assumed to already have

Database `moovo`, owned by role `moovo`, on the shared `oxy-postgres` instance.
`DATABASE_URL` comes from SSM; the service refuses to boot without it.

**PostGIS is a stated PREREQUISITE, not something a migration installs.**

It is installed once per database by the RDS master user, and it is already
installed on `moovo` (PostGIS 3.5.6, `USE_GEOS=1 USE_PROJ=1 USE_STATS=1`).
`db/migrate.ts` DECLARES it in `REQUIRED_EXTENSIONS`, which is what makes a
database missing it fail early and loudly instead of at the first migration
naming `geography`.

**Never write `CREATE EXTENSION IF NOT EXISTS postgis` into a migration.** The
existence check short-circuits BEFORE the privilege check, so that statement is
a silent no-op where the extension is present and a hard failure where it is
not — protection in appearance only. `CREATE EXTENSION postgis` is also denied
to the role that OWNS the database: PostGIS is not a trusted extension.

Why it is needed at all, measured rather than assumed: `dispatch.service.ts`
finds couriers with `$nearSphere` — that is courier dispatch, the core of the
product — and `search.service.ts` uses `$near`. Those become `geography`
columns with GiST indexes.

## Naming and casing

`casing` comes from `@oxyhq/db`'s `DATABASE_CASING`, read by BOTH
`drizzle.config.ts` (which GENERATES the column names) and `db/postgres.ts`
(which REFERENCES them). Never spell it out in either place: two copies of that
decision produce queries against columns that do not exist, and the failure
appears at runtime rather than at build.

Tables are plural snake_case. Columns are snake_case in the database and
camelCase in TypeScript — the casing setting is what bridges them.

## Ids

Application-generated, never database-generated: the id has to exist before the
row is written so it can be returned, logged and referenced without a round
trip.

**Every `oxyUserId` — and any other id belonging to a foreign service — carries
NO foreign key.** Oxy owns identity; Moovo owns none of those rows and cannot
enforce their existence. A foreign key would either fail on a legitimate write
or require mirroring another service's table, which is the coupling this rule
exists to prevent.

## Closed value sets

`text` plus a CHECK constraint, never a PostgreSQL `enum` type. Adding a value
to a pg enum is DDL that cannot run inside the same transaction as the code
that uses it, and removing one is not supported at all; a CHECK is an ordinary
migration.

## The four Mongoose hooks become CHECK constraints

`job`, `listing`, `shipment` and `vehicle` each carry a `pre('validate')` hook
that enforces a discriminated union — "if `ownerType` is `user`, `oxyUserId` is
required and `storeId` is forbidden". Those are shape rules the database can
state directly.

**Delete the hook, write the CHECK, handle the violation code. Do NOT
re-express the rule at a write chokepoint as well.** A hook re-expressed in
application code restores exactly the race the hook never closed — two
concurrent writers both pass the check and both write — while looking like
belt-and-braces. The constraint is the enforcement; the application's job is to
turn `23514` into a good error message.

## Expiry replaces the TTL indexes, and needs a CALLER

Mongo had five TTL indexes. Four are `expireAfterSeconds: 0` expire-at-date
(`joboffers`, `moderationevents`, `moderationoutboxes`, `quotes`) and one is a
90-day retention on `notifications`.

They become `@oxyhq/db`'s `./expiry` registry — and **the registry is only half
of it.** The package supplies the sweep; Moovo must supply the thing that calls
it on a schedule. A registry with no caller is a TTL that never reaps, which is
invisible until rows nobody expected are still being served.

**The `notifications` sweep MUST carry its partial predicate**
(`status = 'dismissed'`). The Mongo index reaps only dismissed notifications; a
sweep that drops the predicate reaps every notification older than 90 days.
That is data loss wearing housekeeping clothes, and nothing about it looks like
a bug until the rows are gone.

## Geography columns

GeoJSON points become `geography(Point, 4326)` with a GiST index. Store
`[lng, lat]` order as GeoJSON does; PostGIS `ST_MakePoint` takes the same
order, which is the one place the two agree and the easiest to get backwards.

A nullable location is genuinely nullable — the Mongo indexes are `sparse`,
meaning "this courier has not reported a position", which is different from a
position at (0, 0) off the coast of Africa.

## Migrations

Generated by `bun run db:generate`, applied ONLY by `db/migrate.ts` — never
`drizzle-kit migrate`, which is a devDependency that cannot reach the
production image.

Every migration carries exactly one deploy-phase marker: `pre` for additive
changes that the PREVIOUS image can tolerate, `post` for drops, renames and
narrowings that require the new image to be live. There is no default, because
guessing applies destructive DDL against an image still serving traffic.

## Tests

Each test file gets its own throwaway, fully-migrated database
(`db/testDatabase.ts`). The migration runs through `db/migrate.ts`'s own `main`
rather than a second composition of `runMigrations`, so the suite tests the
schema a deployment actually gets.

**`MOOVO_REQUIRE_POSTGRES_TESTS=1` is set in CI**, which turns "skip when
unavailable" into a failing test. Skipping is right on a laptop with no
container and wrong in CI, where a skipped suite and a passing suite are the
same colour.

**Open gap, and it closes with the first migration.** Mutation-tested today:
making the harness skip the migration call entirely still passes every test,
because with an empty journal "migrated" and "did not migrate" produce
identical databases. The first migration must assert the table it creates
exists, and whoever writes it should re-run that mutation to confirm skipping
now fails. The same zero-migration short-circuit means PostGIS is not created
in throwaway databases yet either — `runMigrations` returns before it reaches
`ensureExtensions`, which is the correct order for the real case but means a
green suite today is not evidence PostGIS works.

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

## Constraints the source never enforced

Three constraints in this schema are NOT ports of an existing rule. They state
an invariant the source held only in service code, or not at all:

| Constraint | What the source did |
|---|---|
| `orders_seller_shape_check` | `order.ts` has the same `sellerType` + `sellerOxyUserId`/`storeId` shape as `listing.ts`, but never got a `pre('validate')` hook — enforced in `checkout.service.ts` alone. |
| `listings_location_shape_check` | `listing.location` is an inline nested object with no `required` on either sub-field, so a partial or empty coordinate pair really was persistable. |
| `reports.decision_revision` | Declared on `IReport` and `$set` by the decision worker, but absent from `ReportSchema` — so mongoose's strict mode stripped it from every update and the guard it exists for never held. |

**These are UNVIOLATED, not VERIFIED, and the difference must not be lost.** A
census of `moovo-production` — its instrument mutation-tested against planted
violations first, then confirmed to have reached the right database — found
zero violations of each. It also found every collection empty except
`providers` (2 rows, the `seed-providers.ts` bootstrap set).

An empty collection satisfies every predicate. So "0 violations" means these
constraints cannot fail on data that does not exist; it does NOT mean the
invariants ever held under real traffic. The gaps are real and have simply had
no data to bite.

**Re-run the census immediately before the cutover migration applies.** A CHECK
that was safe against an empty table is not automatically safe against a
populated one, and the window between landing this schema and cutting over is
exactly where that changes. If any count comes back non-zero, the constraint
needs a repair pass or a narrower form — that is a decision, not a CHECK.

## What the port changes on purpose

Deliberate divergences from the source, recorded here because a behaviour
change that is written down is a decision and the same change undocumented is a
bug report three months later.

- **`counters` becomes two SEQUENCEs**, not a table. The collection was Mongo's
  only way to express a sequence, and porting the workaround would carry a
  row-level hotspot across for nothing. `START WITH 1` is measured: the live
  `counters` collection is empty, so the generator has never incremented.
- **`courier_profiles.vehicleIds` is dropped.** Both writers admit only
  vehicles the courier owns (`setActiveVehicle` throws `forbidden` otherwise),
  so the array was exactly `select id from vehicles where owner_type='courier'
  and courier_oxy_user_id = $1` — which `listVehicles` already answers that
  way. A Postgres array cannot carry a foreign key on its elements, so a
  deleted vehicle would dangle there forever.
- **`cart_items.variant_id` cascades.** Deleting a variant currently leaves a
  cart line pointing at a dead variant, which fails at hydration; now the line
  vanishes. Better behaviour, but different from production.
- **Empty-string defaults are not carried over.** `@oxyhq/db`'s invariant gate
  refuses a `''` default schema-wide, because `''` is a value standing in for
  absence. The affected columns stay NOT NULL with no database default, so an
  omitted description fails loudly rather than being invented.
- **The one partial-reap rule becomes a GENERATED COLUMN.** `notifications`
  carried a `partialFilterExpression`, and `ExpirySweepTarget` has no predicate
  field, so the condition became `dismissed_since`. The other four targets are
  flat — and `job_offers` is flat DELIBERATELY: its source index carries no
  partial filter, and an earlier version that narrowed it to already-flipped
  rows was reverted, because that disables the bounded-growth backstop in the
  one situation a backstop exists for (a wedged `offered → expired` sweep).
  Fidelity, and the same reasoning that keeps search on its declared sort.

## Geo queries: which ordering each caller actually gets

Measured against a real mongod (8.2.6), because it is not answerable from
source: **an explicit `.sort()` OVERRIDES `$near`'s distance ordering**, and
any sort does, verified with `_id` as a control. No error is raised.

- `dispatch.service.ts` chains **no** `.sort()`, so it relies on the operator's
  nearest-first order and `.limit(waveSize)` takes the nearest N. The Postgres
  port MUST preserve distance ordering — `ORDER BY location <-> point`.
- `search.service.ts` chains `.sort(buildSort(...))`, which never special-cases
  `query.near`. So its live behaviour is: filter to the radius, then order by
  `publishedAt` or price. The port is `ST_DWithin` as a FILTER plus the
  declared sort — **not** distance ordering. Making search distance-ordered
  would be a better product and is a separate change with its own before/after;
  landing it inside a migration would make any post-cutover complaint
  impossible to attribute to a port defect rather than an intended change.

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

**Both gaps are CLOSED by migration `0000`**, and re-measured rather than
assumed:

- *Does the harness call the migrator?* `harness.realdb.test.ts` asserts a real
  table exists. Deleting the `runMigrateEntrypoint(...)` call from
  `testDatabase.ts` now fails that test, where before it failed nothing.
- *Does PostGIS land?* The same file asserts `pg_extension` carries `postgis`
  and that `geography` is usable. With an empty journal `runMigrations`
  returned before `ensureExtensions` and the extension was never created.

**The first attempt at closing gap 1 did not work, and the reason is worth
keeping.** `it('migrates cleanly when the target matches')` calls the migrator
ITSELF, so an assertion made later in the file was satisfied by that test's
side effect rather than by the harness — the mutation still passed. The
assertions therefore read a snapshot captured in `beforeAll`, which is
independent of what any other test does and of the order they run in. A test
that depends on another test's side effect is a false green waiting to happen.

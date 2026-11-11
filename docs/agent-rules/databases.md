<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Databases

**PostgreSQL is the authority.** Every courier domain — providers,
notifications, addresses, shipments, quotes, fleet, jobs, dispatch offers,
moderation, sequences — runs on it, over the 34 tables in migration `0000`.
Schema, conventions and the migration rules are in
`packages/backend/src/db/schema/CONVENTIONS.md`.

**PostgreSQL is the only store.** There is no second database, no ODM model
layer and no rollback target.

`DATABASE_URL` is the only store configuration, and `db/postgres.ts` REFUSES to
open without it rather than defaulting to a local server — a default makes a
misconfigured task boot, report healthy-ish and fail every request. It does not
yet gate BOOT: the server still listens and the expiry sweeper announces itself
as not running. Making it required is a deliberate behaviour change nobody has
taken.

**`/health/ready` asks the store a REAL question** (`select 1`) rather than
inferring reachability from a connection string, and names the dependency in
its 503. The `oxy-moovo` target group health-checks it (matcher 200, 30s,
threshold 3), so it decides whether a task receives traffic.


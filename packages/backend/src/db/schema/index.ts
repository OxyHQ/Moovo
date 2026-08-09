/**
 * Every table this service owns, in one barrel.
 *
 * EMPTY ON PURPOSE, for now. This change lands the Postgres pipeline —
 * container, migrator, throwaway-database harness, CI — ahead of any schema, so
 * that the first domain table arrives on machinery that has already been proven
 * end to end rather than alongside it. A schema and an unproven harness landing
 * together means a failure has two candidate causes and neither is ruled out.
 *
 * Binding decisions for everything in this directory — the PostGIS prerequisite,
 * ids and foreign keys, closed value sets, the hooks that become CHECKs, and the
 * expiry sweep — are in `CONVENTIONS.md` beside this file. Read it first.
 *
 * `drizzle-kit generate` reads THIS file, so a table is only migrated once it is
 * exported here. A table defined in a sibling module and not re-exported is
 * invisible to the generator and produces no migration — and the omission looks
 * exactly like "no schema change to generate".
 */

// Intentionally no exports yet. The first domain table replaces this comment.
export {};

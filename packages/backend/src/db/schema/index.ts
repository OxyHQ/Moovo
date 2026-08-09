/**
 * Every table this service owns, in one barrel.
 *
 * Binding decisions for everything in this directory — the PostGIS
 * prerequisite, ids and foreign keys, closed value sets, the hooks that become
 * CHECKs, and the expiry sweep — are in `CONVENTIONS.md` beside this file.
 * Read it first.
 *
 * `drizzle-kit generate` reads THIS file, so a table is only migrated once it
 * is exported here. A table defined in a sibling module and not re-exported is
 * invisible to the generator and produces no migration — and the omission
 * looks exactly like "no schema change to generate", which is why the schema
 * test asserts the exported table COUNT rather than trusting this list to be
 * complete by inspection.
 */

export * from './catalog';
export * from './commerce';
export * from './engagement';
export * from './fleet';
export * from './moderation';
export * from './notifications';
export * from './sequences';
export * from './stores';
export * from './transport';

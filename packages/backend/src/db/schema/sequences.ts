/**
 * Human-friendly, sequential order and job numbers.
 *
 * ## The `counters` collection does not become a table
 *
 * The source keeps `{_id: <sequence name>, seq: Number}` and allocates with
 * `findByIdAndUpdate($inc, {upsert: true})` — one document per sequence, every
 * concurrent checkout contending for the same row. That is Mongo's only way to
 * express a sequence; Postgres has a real one, so porting the WORKAROUND
 * instead of the intent would carry a row-level hotspot across for nothing.
 *
 * Both behave identically where it matters — an allocated number is never
 * reused, and neither rolls back, so both leave gaps when a transaction
 * aborts. Nothing in the source depends on the numbers being contiguous.
 *
 * The `MRC-`/`MOV-` prefixes and the six-digit zero padding are NOT modelled
 * here: they are presentation, applied by `nextOrderNumber()`/`nextJobNumber()`
 * at the call site, exactly as they are today.
 *
 * ## Two traps for whoever wires the call sites up
 *
 * `nextval()` returns `bigint`, and postgres.js decodes `bigint` as a STRING.
 * So `max + 1` in JavaScript is string concatenation (`"41" + 1 === "411"`),
 * and `tsc` will not say a word because the value is typed `string`. Read the
 * value with an explicit `Number(...)` before formatting it.
 *
 * And a cutover must SEED each sequence past the highest number already
 * issued, with `setval`. A sequence left at 1 re-issues `MRC-000001`, which
 * collides with the unique index on `orders.order_number` — the failure is at
 * least loud, but it happens at a customer's checkout.
 *
 * `START WITH 1` is a MEASURED fact rather than a default nobody checked: a
 * census of `moovo-production` found the `counters` collection empty, with no
 * document for either `order` or `job`, so the generator never incremented in
 * production and there is no maximum to seed past.
 *
 * **SETTLED 2026-08-10 — no seeding step is needed, permanently.** The final
 * restore-verified dump records `counters: 0` (`counts-at-dump.json` in
 * `s3://oxy-mongo-backups-usw2-237343248947/final/2026-08-10/`) and the source
 * database is destroyed, so the count cannot change. The "confirm again at
 * cutover" this comment used to carry is discharged rather than outstanding.
 */

import { pgSequence } from 'drizzle-orm/pg-core';

/** Backs `MRC-<seq>` order numbers. */
export const orderNumberSeq = pgSequence('order_number_seq', {
  startWith: 1,
  increment: 1,
});

/** Backs `MOV-<seq>` job numbers. */
export const jobNumberSeq = pgSequence('job_number_seq', {
  startWith: 1,
  increment: 1,
});

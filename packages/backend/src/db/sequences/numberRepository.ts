/**
 * Human-friendly, sequential order and job numbers.
 *
 * The source kept a `counters` collection — `{_id: <name>, seq: Number}` with
 * `findByIdAndUpdate($inc, {upsert: true})` — because that is Mongo's only way
 * to express a sequence. Postgres has a real one, so `db/schema/sequences.ts`
 * declares `order_number_seq` and `job_number_seq` and this module allocates
 * from them. Porting the workaround would have carried a row-level hotspot
 * across for nothing: every concurrent checkout contended for one document.
 *
 * Both are identical where it matters — an allocated number is never reused,
 * and neither rolls back, so both leave gaps when a transaction aborts. Nothing
 * in the source depends on the numbers being contiguous.
 *
 * ## The bigint decode, measured rather than repeated
 *
 * `nextval()` returns `bigint` and postgres.js decodes `bigint` as a STRING.
 * The received wisdom is that this breaks the formatting, and for THIS code it
 * does not: `String("1").padStart(6, '0')` is `"000001"`, exactly as
 * `String(1).padStart(6, '0')` is. The formatting path is string-shaped
 * throughout, so a string `seq` produces a correct number.
 *
 * The `Number(...)` is therefore a guard on ARITHMETIC that does not exist yet
 * — `seq + 1` would be `"11"` rather than `12`, silently, with `tsc` seeing
 * nothing because the value is typed `string`. It is kept because the next
 * person to touch this will reach for a comparison or an increment, and
 * `sequence-numbers.realdb.test.ts` pins the driver's actual decoding so the
 * claim above stays a measurement instead of decaying into a comment.
 */

import { sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';

/** Prefix prepended to every order number. */
const ORDER_NUMBER_PREFIX = 'MRC-';
/** Prefix prepended to every job number. */
const JOB_NUMBER_PREFIX = 'MOV-';
/** Zero-padding width of the numeric portion of a sequence number. */
const NUMBER_PAD = 6;

/**
 * Allocate the next value of a sequence.
 *
 * `nextval` is exempt from transaction rollback by design, which is what makes
 * it safe under concurrency and is also why a failed booking burns a number.
 * That matches the source: `$inc` did not roll back either.
 */
async function nextSequenceValue(
  sequenceName: 'order_number_seq' | 'job_number_seq',
  db: DatabaseOrTransaction,
): Promise<number> {
  const [row] = await db.execute<{ value: string }>(
    sql`select nextval(${sequenceName})::text as value`,
  );
  if (!row) {
    throw new Error(`Allocating from ${sequenceName} returned no row`);
  }
  return Number(row.value);
}

/** Format an allocated value as a prefixed, zero-padded number. */
function format(prefix: string, value: number): string {
  return `${prefix}${String(value).padStart(NUMBER_PAD, '0')}`;
}

/**
 * Atomically allocate the next order number (`MRC-000123`).
 *
 * Two concurrent callers always receive distinct numbers — the property the
 * source's `$inc` provided and the only one any caller relies on.
 */
export async function nextOrderNumber(db: DatabaseOrTransaction = getDb()): Promise<string> {
  return format(ORDER_NUMBER_PREFIX, await nextSequenceValue('order_number_seq', db));
}

/** Atomically allocate the next job number (`MOV-000123`). */
export async function nextJobNumber(db: DatabaseOrTransaction = getDb()): Promise<string> {
  return format(JOB_NUMBER_PREFIX, await nextSequenceValue('job_number_seq', db));
}

/**
 * Order and job numbers against a real PostgreSQL sequence.
 *
 * **Every case here allocates at least TWICE.** A single allocation returns the
 * same answer whether the driver handed back `1` or `"1"`, and whether the
 * allocator increments or not — so a one-shot test asserting `MOV-000001`
 * proves nothing about either. The second allocation is what distinguishes a
 * working sequence from a constant.
 *
 * The suite also pins WHAT THE DRIVER RETURNS, because the module's comment
 * makes a measured claim — that `bigint`-as-string does NOT break the
 * formatting path — and a claim like that decays into folklore unless a test
 * holds it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import { nextJobNumber, nextOrderNumber } from '../numberRepository';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function database(): SuiteDatabase['db'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.db;
}

describeIfPostgres('order and job numbers', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('allocates job numbers that advance by one', async () => {
    const first = await nextJobNumber();
    const second = await nextJobNumber();
    const third = await nextJobNumber();

    // Formatted, prefixed and padded — and ADVANCING, which one allocation
    // could never show.
    expect(first).toBe('MOV-000001');
    expect(second).toBe('MOV-000002');
    expect(third).toBe('MOV-000003');
  });

  it('allocates order numbers from a SEPARATE sequence', async () => {
    // Two sequences, not one shared counter: an order number advancing because
    // a job was booked would be a real defect and is invisible unless both are
    // allocated in the same test.
    const order = await nextOrderNumber();
    expect(order).toBe('MRC-000001');

    await nextJobNumber();
    expect(await nextOrderNumber()).toBe('MRC-000002');
  });

  it('never issues the same number twice under concurrency', async () => {
    // The single property every caller depends on. Twenty concurrent
    // allocations, all distinct.
    const numbers = await Promise.all(Array.from({ length: 20 }, () => nextJobNumber()));
    expect(new Set(numbers).size).toBe(20);
  });

  /**
   * The measured claim behind the module's `Number(...)`.
   *
   * `nextval()` is `bigint` and postgres.js decodes it as a STRING. That does
   * NOT break the formatting path, because `String("7").padStart(6, '0')` and
   * `String(7).padStart(6, '0')` are the same — which is why removing the
   * coercion leaves this suite green, and why the module says so rather than
   * claiming a bug it does not have. What it WOULD break is arithmetic, and
   * this case shows exactly that shape.
   */
  it('decodes a raw nextval as a string, which is why arithmetic needs the coercion', async () => {
    const [row] = await database().execute<{ value: string }>(
      sql`select nextval('job_number_seq') as value`,
    );

    expect(typeof row?.value).toBe('string');
    // Formatting survives it...
    expect(String(row?.value).padStart(6, '0')).toMatch(/^0+\d+$/);
    // ...arithmetic does not. This is the failure the coercion guards against.
    expect((row?.value as unknown as number) + 1).toContain('1');
  });

  it('does not roll back an allocated number when its transaction aborts', async () => {
    const before = await nextJobNumber();

    await expect(
      database().transaction(async (tx) => {
        await nextJobNumber(tx);
        throw new Error('booking failed after the number was allocated');
      }),
    ).rejects.toThrow('booking failed');

    const after = await nextJobNumber();

    // The aborted allocation is BURNED, leaving a gap — identical to the
    // source's `$inc`, which did not roll back either. Nothing depends on the
    // numbers being contiguous, and a sequence that rolled back would hand two
    // concurrent bookings the same number.
    const value = (n: string) => Number(n.slice('MOV-'.length));
    expect(value(after)).toBe(value(before) + 2);
  });
});

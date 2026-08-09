/**
 * The feedback domain against a REAL Postgres server.
 *
 * A mocked drizzle call accepts every statement, including ones the server
 * rejects — so a CHECK constraint, a `bigint` the driver decodes as a string,
 * and a `null` where the old store wrote nothing are all invisible to a mock.
 * Each is a real defect this port could have shipped, and each is pinned here.
 *
 * The three worth naming, because none of them fails loudly on its own:
 *
 *  - **`null` is not absence.** Mongo OMITTED an unset optional field; Postgres
 *    returns `null`. The old `!== undefined` test passes for `null`, so a
 *    straight translation starts emitting `{"rating": null}` where the API
 *    emitted nothing. No error, no failing test — clients just begin receiving
 *    a field that never existed.
 *  - **`count(*)` is `bigint`, which postgres.js decodes as a STRING.** So
 *    `total + 1` is string concatenation and `tsc` says nothing, because
 *    drizzle types the result `number`. Pinned by ARITHMETIC and by `typeof`,
 *    not by `toBe(2)` — `"2"` and `2` both satisfy a loose equality and even a
 *    strict one reads fine at a glance.
 *  - **Ownership is a WHERE clause, not an afterthought.** The read must return
 *    nothing for another user's id rather than returning the row for a caller
 *    to filter.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/testDatabase';
import { feedback } from '../../db/schema/engagement';
import {
  countFeedbackForUser,
  findFeedbackForUser,
  insertFeedback,
  listFeedbackForUser,
} from '../../db/feedback/feedbackRepository';
import { create, getById, list } from '../feedback.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const OWNER = 'oxy-user-owner';
const STRANGER = 'oxy-user-stranger';

describeIfPostgres('feedback on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('stores a submission and reads it back through the service', async () => {
    const created = await create(OWNER, {
      type: 'bug',
      rating: 4,
      message: 'The courier map froze.',
      email: 'reporter@example.com',
      metadata: { platform: 'ios', appVersion: '1.2.3', deviceInfo: 'iPhone 15' },
    });

    expect(created.status).toBe('pending');
    expect(created.rating).toBe(4);
    expect(await getById(OWNER, created.id)).toEqual(created);
  });

  it('flattens the three retained metadata keys and drops anything else', async () => {
    const row = await insertFeedback({
      oxyUserId: OWNER,
      type: 'other',
      message: 'metadata shape',
      // `secret` stands for every key the source's strict-mode schema silently
      // dropped. A `jsonb` bag would have started persisting it — a widening of
      // what a client can store in a table that takes free-form user input.
      metadata: { platform: 'web', appVersion: '9.9.9', deviceInfo: 'Firefox', secret: 'nope' },
    });

    expect(row.metadataPlatform).toBe('web');
    expect(row.metadataAppVersion).toBe('9.9.9');
    expect(row.metadataDeviceInfo).toBe('Firefox');
    expect(Object.keys(row)).not.toContain('secret');
  });

  it('OMITS rating and email when unset, rather than emitting null', async () => {
    // The regression that would ship silently. `toEqual` ignores explicitly
    // undefined keys, so the assertion is on the serialized JSON — which is
    // what a client actually receives, and the only form where "absent" and
    // "null" are distinguishable.
    const created = await create(OWNER, { type: 'feature', message: 'no rating, no email' });

    expect(created.rating).toBeUndefined();
    expect(created.email).toBeUndefined();

    const json = JSON.parse(JSON.stringify(await getById(OWNER, created.id))) as Record<
      string,
      unknown
    >;
    expect('rating' in json).toBe(false);
    expect('email' in json).toBe(false);
  });

  it('counts as a NUMBER, so pagination arithmetic is not string concatenation', async () => {
    const user = `count-${uuidv7()}`;
    for (let i = 0; i < 3; i += 1) {
      await insertFeedback({ oxyUserId: user, type: 'other', message: `m${i}` });
    }

    const total = await countFeedbackForUser(user);

    // `typeof` first, because that is the actual defect: postgres.js decodes
    // `bigint` as a string and drizzle's `count()` only avoids it by carrying
    // `.mapWith(Number)` — a dependency internal this pins rather than trusts.
    expect(typeof total).toBe('number');
    expect(total).toBe(3);
    // And the arithmetic, because "3" + 1 === "31" is the shape the bug takes
    // at a call site. A single assertion on the value alone would pass for the
    // string too under a loose read.
    expect(total + 1).toBe(4);
  });

  it('scopes every read to the owner', async () => {
    const created = await create(OWNER, { type: 'bug', message: 'owner only' });

    expect(await findFeedbackForUser(STRANGER, created.id)).toBeNull();
    await expect(getById(STRANGER, created.id)).rejects.toThrow(/not found/i);
    // The stranger's own list must be empty rather than merely excluding this
    // row — a missing WHERE clause would show every user's submissions.
    expect(await list(STRANGER, { page: 1, limit: 50 })).toEqual({ data: [], total: 0 });
  });

  it('orders newest first, with a total order when timestamps tie', async () => {
    const user = `order-${uuidv7()}`;
    const db = suite?.db;
    if (db === undefined) throw new Error('suite database missing');

    // Written with an IDENTICAL createdAt on purpose. The source sorted on that
    // column alone, so with offset pagination two rows sharing a timestamp have
    // no defined order between pages — one can be served twice and another
    // never. Ties are exactly the case a naturally-timed fixture never produces.
    const tied = new Date('2026-01-01T00:00:00.000Z');
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) {
      await db.insert(feedback).values({
        id,
        oxyUserId: user,
        type: 'other',
        message: id,
        status: 'pending',
        createdAt: tied,
        updatedAt: tied,
      });
    }

    const first = await listFeedbackForUser(user, { limit: 2, offset: 0 });
    const second = await listFeedbackForUser(user, { limit: 2, offset: 2 });
    const seen = [...first, ...second].map((row) => row.id);

    // The property that matters is that paging covers every row exactly once.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    // uuid v7 is time-ordered, so descending id is the deterministic tiebreak.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('refuses a rating outside 1..5 and an unknown type at the DATABASE', async () => {
    // These CHECKs are the backstop behind `feedbackSchema`. A mocked insert
    // would accept both, which is the whole reason this file runs on a server.
    await expect(
      insertFeedback({ oxyUserId: OWNER, type: 'bug', message: 'bad rating', rating: 9 }),
    ).rejects.toThrow();
    await expect(
      insertFeedback({ oxyUserId: OWNER, type: 'not-a-type', message: 'bad type' }),
    ).rejects.toThrow();
  });
});

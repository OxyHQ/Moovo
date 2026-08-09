/**
 * The address domain against a REAL Postgres server.
 *
 * This REPLACES a mocked `address.service.test.ts`, and the replacement is not
 * like-for-like — it is stronger in the one way that matters. The mocked
 * version asserted the SHAPE of the Mongo filter:
 *
 *     expect(filter).toEqual({ oxyUserId: USER, isDefault: true, _id: { $ne: ADDR_ID } });
 *
 * which is a claim about a query, not about the invariant. It would pass for a
 * query that was never executed, and it could not observe the outcome the
 * invariant is actually about — that exactly one default survives. Every test
 * here asserts STATE instead, read back from the database.
 *
 * The invariant also became genuinely harder to hold when it moved: promotion
 * is now two statements, and between them the user has NO default. That window
 * only exists on a real server, so it can only be tested on one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/testDatabase';
import { addresses } from '../../db/schema/commerce';
import { findAddressForUser, listAddressesForUser } from '../../db/addresses/addressRepository';
import { create, list, remove, update } from '../address.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const user = (label: string): string => `${label}-${uuidv7()}`;

const INPUT = {
  recipientName: 'Jane',
  line1: '1 Main St',
  city: 'Town',
  postalCode: '12345',
  country: 'US',
};

describeIfPostgres('addresses on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  /**
   * Insert one address with an EXPLICIT `createdAt`, returning its id.
   *
   * The service cannot set it, and the ordering cases need rows that genuinely
   * differ in that column — see the note on the ordering test.
   */
  async function seedAt(
    oxyUserId: string,
    label: string,
    createdAt: string,
    isDefault: boolean,
  ): Promise<string> {
    const db = suite?.db;
    if (db === undefined) throw new Error('suite database missing');
    const at = new Date(createdAt);
    const [row] = await db
      .insert(addresses)
      .values({ id: uuidv7(), oxyUserId, ...INPUT, label, isDefault, createdAt: at, updatedAt: at })
      .returning();
    if (row === undefined) throw new Error('seeding an address returned no row');
    return row.id;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('makes the FIRST address the default and later ones not', async () => {
    const owner = user('first');

    const first = await create(owner, INPUT);
    expect(first.isDefault).toBe(true);

    const second = await create(owner, INPUT);
    expect(second.isDefault).toBe(false);
  });

  it('promoting leaves EXACTLY ONE default — asserted as state, not as a filter', async () => {
    const owner = user('promote');
    const a = await create(owner, INPUT);
    const b = await create(owner, INPUT);
    const c = await create(owner, INPUT);

    await update(owner, c.id, { isDefault: true });

    const rows = await listAddressesForUser(owner);
    const defaults = rows.filter((row) => row.isDefault).map((row) => row.id);
    // The whole invariant, in one assertion the mocked version could not make.
    expect(defaults).toEqual([c.id]);
    expect(rows.map((row) => row.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('a non-promoting update leaves the existing default alone', async () => {
    const owner = user('nopromote');
    const a = await create(owner, INPUT);
    const b = await create(owner, INPUT);

    await update(owner, b.id, { recipientName: 'John' });

    const rows = await listAddressesForUser(owner);
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([a.id]);
    expect((await findAddressForUser(owner, b.id))?.recipientName).toBe('John');
  });

  it('a patch only writes the fields it carries', async () => {
    // The `set(patch)` trap: writing every key of the patch object would put
    // NULL into every field the caller omitted, silently emptying an address.
    const owner = user('patch');
    const created = await create(owner, { ...INPUT, label: 'Home', phone: '+15550000' });

    await update(owner, created.id, { city: 'Newtown' });

    const row = await findAddressForUser(owner, created.id);
    expect(row?.city).toBe('Newtown');
    expect(row?.label).toBe('Home');
    expect(row?.phone).toBe('+15550000');
    expect(row?.line1).toBe('1 Main St');
  });

  it('answers a patch with no real field as a READ, not a 500', async () => {
    // The input shape that makes the guarded and unguarded versions disagree,
    // and the one every other fixture here misses: `address.service` always
    // passes all ten keys, `undefined` for the omitted ones, so `values` is
    // never empty without the repository's filter and the read branch never
    // fires. The UPDATE then still SUCCEEDS — `updatedAt` is always a real
    // value, so drizzle has one column to set — and quietly bumps
    // `updated_at` on a request that asked for no change.
    //
    // So the assertion has to be on `updatedAt`. Found the hard way: this case
    // was added after mutation testing, and the FIRST version of it still let
    // the mutation live, because it only asserted the fields it expected to be
    // unchanged — which they were.
    const owner = user('empty-patch');
    const created = await create(owner, { ...INPUT, label: 'Home' });
    const before = (await findAddressForUser(owner, created.id))?.updatedAt;

    const unchanged = await update(owner, created.id, {});

    expect(unchanged.id).toBe(created.id);
    expect(unchanged.label).toBe('Home');
    expect(unchanged.city).toBe('Town');
    // The discriminator.
    expect(unchanged.updatedAt).toBe(created.updatedAt);
    expect((await findAddressForUser(owner, created.id))?.updatedAt).toEqual(before);
  });

  it('lists default first, then newest', async () => {
    // Timestamps written EXPLICITLY, not produced by three creates in a loop.
    // Those land in the same millisecond, which makes `created_at` tie and
    // hands the decision to `id DESC` — and uuid v7 is NOT monotonic within a
    // millisecond, so the assertion becomes a coin flip. Measured here: the
    // loop version failed intermittently, on the generator's luck rather than
    // on anything about the code.
    const owner = user('order');
    await seedAt(owner, 'oldest', '2026-01-01T00:00:00.000Z', true);
    await seedAt(owner, 'middle', '2026-01-02T00:00:00.000Z', false);
    await seedAt(owner, 'newest', '2026-01-03T00:00:00.000Z', false);

    const rows = await list(owner);
    // The first address is the default, so it leads despite being oldest —
    // `is_default DESC` before `created_at DESC`. Getting the two the other way
    // round still returns every row, which is why the ORDER is asserted.
    expect(rows[0]?.label).toBe('oldest');
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[1]?.label).toBe('newest');
    expect(rows[2]?.label).toBe('middle');
  });

  it('deleting the default promotes the newest survivor', async () => {
    // Explicit timestamps, for the same reason as the ordering case above:
    // "newest" is only a well-defined answer when the rows differ in
    // `created_at`, and three creates in a loop do not guarantee that.
    const owner = user('delete');
    const first = await seedAt(owner, 'first', '2026-01-01T00:00:00.000Z', true);
    await seedAt(owner, 'second', '2026-01-02T00:00:00.000Z', false);
    const third = await seedAt(owner, 'third', '2026-01-03T00:00:00.000Z', false);

    await remove(owner, first);

    const rows = await listAddressesForUser(owner);
    expect(rows).toHaveLength(2);
    // Newest survivor, not "the next one in some arbitrary order".
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([third]);
  });

  it('deleting a NON-default promotes nothing', async () => {
    const owner = user('delete-nondefault');
    const first = await create(owner, INPUT);
    const second = await create(owner, INPUT);

    await remove(owner, second.id);

    const rows = await listAddressesForUser(owner);
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([first.id]);
  });

  it('deleting the only address leaves nothing to promote', async () => {
    const owner = user('delete-last');
    const only = await create(owner, INPUT);

    await remove(owner, only.id);

    expect(await listAddressesForUser(owner)).toEqual([]);
  });

  it('scopes every operation to the owner', async () => {
    const owner = user('owner');
    const stranger = user('stranger');
    const created = await create(owner, INPUT);

    expect(await findAddressForUser(stranger, created.id)).toBeNull();
    await expect(update(stranger, created.id, { city: 'Nope' })).rejects.toThrow(/not found/i);
    await expect(remove(stranger, created.id)).rejects.toThrow(/not found/i);

    // And the stranger's refused delete must not have deleted anything.
    expect(await listAddressesForUser(owner)).toHaveLength(1);
  });

  it('OMITS label, line2, region and phone when unset', async () => {
    const owner = user('dto');
    await create(owner, INPUT);

    const [dto] = await list(owner);
    const json = JSON.parse(JSON.stringify(dto)) as Record<string, unknown>;
    // Serialized JSON, because `toEqual` ignores explicitly-undefined keys and
    // so cannot tell "absent" from "null" — which is the entire regression.
    // A required field is asserted PRESENT beside them, so a serializer that
    // dropped everything could not pass this by emitting an empty object.
    expect(json.recipientName).toBe('Jane');
    for (const field of ['label', 'line2', 'region', 'phone']) {
      expect(field in json).toBe(false);
    }
  });
});

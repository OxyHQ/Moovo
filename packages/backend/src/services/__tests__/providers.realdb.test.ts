/**
 * The provider registry against a REAL Postgres server.
 *
 * `providers` is the ONLY table in this port that carries production rows —
 * two, written by `seedProviders` at boot — so it is the one repository whose
 * behaviour a backfill has to agree with.
 *
 * Two semantics carry the weight, and each is silent when wrong:
 *
 *  - **The seed must be `DO NOTHING`, not `DO UPDATE`.** The source uses
 *    `$setOnInsert` alone so "a deploy never clobbers operator edits". A
 *    `DO UPDATE` resets `enabled`/`supportedCountries`/`config` on every boot,
 *    and the operator's change reverts itself hours later with nothing logged.
 *    Only a SECOND seed after an edit can tell the two apart.
 *  - **`supportedTypes` is queried by CONTAINMENT.** Mongo's
 *    `{supportedTypes: 'package'}` matches when the stored array holds that
 *    value. `eq()` compiles and matches NOTHING, so the quote fan-out would
 *    call no carrier and simply return fewer quotes — indistinguishable from
 *    carriers declining.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/testDatabase';
import {
  findProviderById,
  findProvidersByIds,
  insertProviderIfAbsent,
  listEnabledProvidersForType,
} from '../../db/transport/providerRepository';
import { providers } from '../../db/schema/transport';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const key = (label: string): string => `${label}-${uuidv7()}`;

function seed(overrides: Partial<Parameters<typeof insertProviderIfAbsent>[0]> = {}) {
  return {
    key: key('carrier'),
    name: 'Test Carrier',
    enabled: true,
    supportedTypes: ['package'],
    supportedCountries: [],
    config: {},
    ...overrides,
  };
}

describeIfPostgres('providers on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('creates on the first seed and reports it', async () => {
    expect(await insertProviderIfAbsent(seed())).toBe(true);
  });

  it('a repeat seed creates NOTHING and preserves operator edits', async () => {
    // The case that distinguishes DO NOTHING from DO UPDATE, and the only one
    // that can: a first seed alone behaves identically under both.
    const input = seed({ enabled: true, supportedCountries: [], config: {} });
    expect(await insertProviderIfAbsent(input)).toBe(true);

    const db = suite?.db;
    if (db === undefined) throw new Error('suite database missing');

    // An operator disables the carrier and narrows its countries — exactly the
    // edits the source's comment says a deploy must never clobber.
    await db
      .update(providers)
      .set({ enabled: false, supportedCountries: ['ES'], config: { rateLimit: 5 } })
      .where(eq(providers.key, input.key));

    // Boot again.
    expect(await insertProviderIfAbsent(input)).toBe(false);

    const [after] = await db.select().from(providers).where(eq(providers.key, input.key));
    expect(after?.enabled).toBe(false);
    expect(after?.supportedCountries).toEqual(['ES']);
    expect(after?.config).toEqual({ rateLimit: 5 });
    expect(after?.name).toBe('Test Carrier');
  });

  it('matches supportedTypes by CONTAINMENT, not equality', async () => {
    const multi = seed({ supportedTypes: ['package', 'food'] });
    await insertProviderIfAbsent(multi);

    const forPackage = await listEnabledProvidersForType('package');
    const forFood = await listEnabledProvidersForType('food');
    const forMove = await listEnabledProvidersForType('move');

    // A provider declaring TWO types must answer for each of them. `eq()`
    // against the whole array matches neither, which is the silent failure.
    expect(forPackage.map((p) => p.key)).toContain(multi.key);
    expect(forFood.map((p) => p.key)).toContain(multi.key);
    expect(forMove.map((p) => p.key)).not.toContain(multi.key);
  });

  it('excludes disabled providers from the fan-out', async () => {
    const off = seed({ enabled: false, supportedTypes: ['move'] });
    await insertProviderIfAbsent(off);

    expect((await listEnabledProvidersForType('move')).map((p) => p.key)).not.toContain(off.key);
  });

  it('batches ids without a row constructor, and answers empty for none', async () => {
    const a = seed();
    const b = seed();
    await insertProviderIfAbsent(a);
    await insertProviderIfAbsent(b);

    const all = await listEnabledProvidersForType('package');
    const ids = all.filter((p) => p.key === a.key || p.key === b.key).map((p) => p.id);
    expect(ids).toHaveLength(2);

    const batched = await findProvidersByIds(ids);
    expect(batched.map((p) => p.id).sort()).toEqual([...ids].sort());
    // The single-id read agrees with the batch — it is what the booking path
    // uses to resolve a quote's carrier, on a different code path.
    const first = ids[0] ?? '';
    expect((await findProviderById(first))?.id).toBe(first);
    expect(await findProviderById(uuidv7())).toBeNull();
    // The empty case is a separate branch: `inArray` with no values is not a
    // predicate that matches everything, and the caller short-circuits anyway.
    expect(await findProvidersByIds([])).toEqual([]);
  });

  it('refuses a duplicate key and an unknown shipment type at the DATABASE', async () => {
    const input = seed();
    expect(await insertProviderIfAbsent(input)).toBe(true);
    // Same key, different name — DO NOTHING absorbs it rather than erroring,
    // which is what makes a warm boot safe.
    expect(await insertProviderIfAbsent({ ...input, name: 'Other' })).toBe(false);

    await expect(
      insertProviderIfAbsent(seed({ supportedTypes: ['not-a-type'] })),
    ).rejects.toThrow();
  });
});

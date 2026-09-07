/**
 * The carrier seed, against a real server.
 *
 * The seed is a WRITE, so it belongs here rather than in a mocked test: a
 * mocked repository accepts every statement, including ones Postgres rejects.
 *
 * What is actually being pinned is the `DO NOTHING`. `tracking_carriers` is the
 * one table in this domain an OPERATOR edits by hand — `enabled`,
 * `source_kind`, the rate budget, and above all `deep_link_template`, which is
 * the column somebody fixes the morning a carrier reorganises its website. A
 * `DO UPDATE` would revert that fix on the next deploy, hours later, with
 * nothing in the logs connecting the two.
 *
 * "Created 0" is not on its own evidence of that: a `DO UPDATE` writing the
 * same values back would also report nothing new. So the repeat is asserted on
 * `xmin` — the tuple version, which a rewrite bumps even when every column ends
 * up identical and `$onUpdate` therefore leaves `updated_at` alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { seedTrackingCarriers } from '../seed-tracking-carriers.js';
import { registerBuiltInTrackingAdapters } from '../register-tracking-adapters.js';
import { __resetTrackingRegistryForTests } from '../tracking-registry.js';
import { BUILT_IN_TRACKING_CARRIERS } from '../adapters/built-in-carriers.js';
import {
  findTrackingCarrierByKey,
  listEnabledTrackingCarriers,
} from '../../../db/tracking/trackingCarrierRepository.js';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

describeIfPostgres('seeding the tracking carriers', () => {
  let suite: SuiteDatabase | null = null;

  async function tupleVersion(key: string): Promise<{ xmin: string; updatedAt: string }> {
    const [row] = await suite!.client<{ xmin: string; updated_at: string }[]>`
      SELECT xmin::text AS xmin, updated_at::text AS updated_at
      FROM tracking_carriers WHERE key = ${key}
    `;
    return { xmin: row!.xmin, updatedAt: row!.updated_at };
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  beforeEach(() => {
    __resetTrackingRegistryForTests();
    registerBuiltInTrackingAdapters();
  });

  it('creates one row per built-in carrier on a cold boot', async () => {
    // All but `moovo`, which migration 0004 already created: it is structural
    // rather than catalogue, because booking a job writes a pointer row against
    // it and a missing row would fail the booking, not merely the tracker.
    const created = await seedTrackingCarriers();
    expect(created).toBe(BUILT_IN_TRACKING_CARRIERS.length - 1);

    const carriers = await listEnabledTrackingCarriers();
    expect(carriers).toHaveLength(BUILT_IN_TRACKING_CARRIERS.length);
    expect(carriers.map((carrier) => carrier.key)).toContain('moovo');
    // Every carrier ships deep-link-only until its client exists AND somebody
    // has approved how we read it. `public_page` in particular is a legal
    // decision per carrier and must never be a side effect of a deploy.
    expect(carriers.every((carrier) => carrier.sourceKind === 'deep_link_only')).toBe(true);
    expect(carriers.every((carrier) => carrier.deepLinkTemplate.includes('http'))).toBe(true);
  });

  it('writes NOTHING on a warm boot — not even the same values back', async () => {
    const before = await tupleVersion('ups');

    const created = await seedTrackingCarriers();
    expect(created).toBe(0);

    const after = await tupleVersion('ups');
    // `updated_at` alone cannot tell "wrote nothing" from "wrote the same
    // thing", because `$onUpdate` only fires on a real change. `xmin` can.
    expect(after.xmin).toBe(before.xmin);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("never reverts an operator's edit to a carrier's deep link", async () => {
    // The failure this whole `DO NOTHING` exists to prevent: somebody fixes a
    // broken carrier URL at 09:00, and the 17:00 deploy silently puts the
    // broken one back.
    await suite!.client`
      UPDATE tracking_carriers
      SET deep_link_template = 'https://operator.example/fixed?n={number}', enabled = false
      WHERE key = 'seur'
    `;

    await seedTrackingCarriers();

    const carrier = await findTrackingCarrierByKey('seur');
    expect(carrier?.deepLinkTemplate).toBe('https://operator.example/fixed?n={number}');
    expect(carrier?.enabled).toBe(false);
  });

  it('re-creates only the carrier an operator deleted', async () => {
    await suite!.client`DELETE FROM tracking_carriers WHERE key = 'gls'`;
    expect(await seedTrackingCarriers()).toBe(1);
    expect(await findTrackingCarrierByKey('gls')).not.toBeNull();
  });
});

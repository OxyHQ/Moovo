/**
 * What bounds the tracker's tables — and the cascade two of them rely on.
 *
 * `tracked_parcels` is the one table in this schema ANY caller can write to by
 * pasting a string: the anonymous lookup creates a row so the identity can be
 * shared and the carrier called once. Its sweep is therefore a bound on an
 * open-ended table rather than a filing policy.
 *
 * `tracking_checkpoints` and `tracked_parcel_subscriptions` are listed in
 * `UNSWEPT_GROWING_TABLES` on the grounds that `ON DELETE CASCADE` reaps them
 * with their parent. **That claim is what this file exists to prove.** A
 * cascade that was never declared looks exactly like one that was, from
 * anywhere except the catalogue — and the failure is silent, unbounded growth
 * in a table whose registry entry says it is handled.
 *
 * As in `expiry.realdb.test.ts`, every case asserts both halves: what must go
 * is gone, and what must stay is still there. A sweep that deletes everything
 * passes the first half of all of them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';
import { UNSWEPT_GROWING_TABLES, sweepExpiredRowsOnce } from '../expiry';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const LONG_PAST = '2020-01-01T00:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

describeIfPostgres('tracker retention', () => {
  let suite: SuiteDatabase | null = null;

  async function countWhere(table: string, column: string, value: string): Promise<number> {
    const [row] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${suite!.client(table)}
      WHERE ${suite!.client(column)} = ${value}
    `;
    return row?.count ?? 0;
  }

  /** A parcel with a subscription and a checkpoint hanging off it. */
  async function insertParcelWithChildren(id: string, expiresAt: string, number: string) {
    await suite!.client`INSERT INTO tracked_parcels ${suite!.client({
      id,
      carrier_key: 'ups',
      tracking_number: number,
      expires_at: expiresAt,
    })}`;
    await suite!.client`INSERT INTO tracking_checkpoints ${suite!.client({
      id: `cp-${id}`,
      parcel_id: id,
      dedupe_key: `cp-${id}`,
      status: 'in_transit',
      occurred_at: LONG_PAST,
      received_at: LONG_PAST,
    })}`;
    await suite!.client`INSERT INTO tracked_parcel_subscriptions ${suite!.client({
      id: `sub-${id}`,
      parcel_id: id,
      oxy_user_id: 'oxy-ana',
      entered_number: number,
    })}`;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    await suite.client`
      INSERT INTO tracking_carriers (id, key, name, deep_link_template)
      VALUES ('carrier-ups', 'ups', 'UPS', 'https://example.invalid/ups?n={number}')
    `;
    await insertParcelWithChildren('p-lapsed', LONG_PAST, '1Z999AA10123456784');
    await insertParcelWithChildren('p-live', FAR_FUTURE, '1Z999AA10123456785');
    await suite.client`INSERT INTO tracking_webhook_events ${suite.client({
      id: 'evt-lapsed',
      carrier_key: 'ups',
      received_at: LONG_PAST,
      expires_at: LONG_PAST,
    })}`;
    await suite.client`INSERT INTO tracking_webhook_events ${suite.client({
      id: 'evt-live',
      carrier_key: 'ups',
      received_at: LONG_PAST,
      expires_at: FAR_FUTURE,
    })}`;
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('names both child tables as cascade-bounded rather than as decisions owed', () => {
    // The two categories in that list are not interchangeable: one means
    // "somebody still has to choose a number", the other means "nothing is
    // owed, the parent's sweep already handles it". Reading a cascade-bounded
    // table as an open decision sends the next person looking for an owner who
    // does not exist.
    const named = UNSWEPT_GROWING_TABLES.map((entry) => entry.table);
    expect(named).toContain('tracking_checkpoints');
    expect(named).toContain('tracked_parcel_subscriptions');
    for (const entry of UNSWEPT_GROWING_TABLES) {
      expect(entry.why.length).toBeGreaterThan(120);
    }
  });

  it('reaps a lapsed parcel and takes its checkpoints and subscriptions with it', async () => {
    await sweepExpiredRowsOnce();

    expect(await countWhere('tracked_parcels', 'id', 'p-lapsed')).toBe(0);
    // The cascade, asserted rather than assumed. This is the entire basis on
    // which these two tables are absent from `EXPIRY_TARGETS`.
    expect(await countWhere('tracking_checkpoints', 'parcel_id', 'p-lapsed')).toBe(0);
    expect(await countWhere('tracked_parcel_subscriptions', 'parcel_id', 'p-lapsed')).toBe(0);
  });

  it('leaves a live parcel and everything hanging off it untouched', async () => {
    await sweepExpiredRowsOnce();

    expect(await countWhere('tracked_parcels', 'id', 'p-live')).toBe(1);
    expect(await countWhere('tracking_checkpoints', 'parcel_id', 'p-live')).toBe(1);
    expect(await countWhere('tracked_parcel_subscriptions', 'parcel_id', 'p-live')).toBe(1);
  });

  it('reaps a lapsed carrier webhook delivery and keeps a live one', async () => {
    await sweepExpiredRowsOnce();

    expect(await countWhere('tracking_webhook_events', 'id', 'evt-lapsed')).toBe(0);
    expect(await countWhere('tracking_webhook_events', 'id', 'evt-live')).toBe(1);
  });
});

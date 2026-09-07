/**
 * The tracker's writes, against a real server.
 *
 * Mocked repositories accept every statement, including ones Postgres rejects,
 * so every write in this domain is tested here rather than against a double.
 *
 * Three properties are the reason this file exists, and none of them announces
 * itself when broken:
 *
 * 1. **One identity per `(carrier, number)`.** Two people adding the same
 *    parcel must converge on one row, one schedule and one carrier bill.
 * 2. **No conflict may RAISE.** A `23505` aborts the surrounding transaction,
 *    and these writes share one with the subscription. Answering "it already
 *    existed" is not the same as surviving — so the transaction is asserted
 *    still USABLE afterwards.
 * 3. **Re-ingesting a carrier's history writes nothing.** Carriers re-send
 *    everything on every poll. "Returned no rows" is not evidence: a careful
 *    `DO UPDATE` writing identical values would also return nothing new while
 *    bumping every tuple. `xmin` is what separates them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { getDb } from '../../../db/postgres';
import { registerBuiltInTrackingAdapters } from '../register-tracking-adapters.js';
import { __resetTrackingRegistryForTests } from '../tracking-registry.js';
import { seedTrackingCarriers } from '../seed-tracking-carriers.js';
import {
  getParcelDetail,
  listParcels,
  lookupParcel,
  trackParcel,
  untrackParcel,
  updateParcel,
} from '../tracking.service.js';
import {
  findOrCreateParcel,
  findParcelByNumber,
} from '../../../db/tracking/trackedParcelRepository.js';
import { ingestCheckpoints } from '../../../db/tracking/trackingCheckpointRepository.js';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/** A real UPS number: `1Z` plus a body whose check digit agrees. */
const UPS_NUMBER = '1Z999AA10123456784';
/** A real S10 number whose `ES` suffix routes it to Correos. */
const CORREOS_NUMBER = 'RR123456785ES';

describeIfPostgres('the tracking write path', () => {
  let suite: SuiteDatabase | null = null;

  async function countParcels(): Promise<number> {
    const [row] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tracked_parcels
    `;
    return row?.count ?? 0;
  }

  async function parcelRow(number: string) {
    const [row] = await suite!.client<
      {
        id: string;
        carrier_key: string;
        subscriber_count: number;
        next_poll_at: string | null;
        xmin: string;
      }[]
    >`
      SELECT id, carrier_key, subscriber_count, next_poll_at, xmin::text AS xmin
      FROM tracked_parcels WHERE tracking_number = ${number}
    `;
    return row ?? null;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    __resetTrackingRegistryForTests();
    registerBuiltInTrackingAdapters();
    await seedTrackingCarriers();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  beforeEach(async () => {
    await suite!.client`DELETE FROM tracked_parcels`;
  });

  describe('one identity per (carrier, number)', () => {
    it('converges two users on ONE parcel row', async () => {
      await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await trackParcel('oxy-bea', { number: UPS_NUMBER });

      expect(await countParcels()).toBe(1);
      const row = await parcelRow(UPS_NUMBER);
      expect(row?.subscriber_count).toBe(2);
    });

    it('converges a number pasted WITH the separators a carrier prints', async () => {
      // The failure this guards is not an error: two identities, two poll
      // schedules and two carrier bills, with both rows looking perfectly fine.
      await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await trackParcel('oxy-bea', { number: '1z999aa1-0123456784' });

      expect(await countParcels()).toBe(1);
      expect((await parcelRow(UPS_NUMBER))?.subscriber_count).toBe(2);
    });

    it('keeps the same number on two carriers apart', async () => {
      await trackParcel('oxy-ana', { number: '123456789012', carrierKey: 'fedex' });
      await trackParcel('oxy-ana', { number: '123456789012', carrierKey: 'dhl-express' });
      expect(await countParcels()).toBe(2);
    });
  });

  describe('conflicts answer rather than raise', () => {
    it('leaves the transaction USABLE after a losing insert', async () => {
      // Answering `created: false` is not on its own evidence that nothing was
      // poisoned: a raised 23505 would abort the transaction and every later
      // statement would fail with 25P02. So the test does more work afterwards.
      await findOrCreateParcel({ carrierKey: 'ups', trackingNumber: UPS_NUMBER });

      const outcome = await getDb().transaction(async (tx) => {
        const second = await findOrCreateParcel(
          { carrierKey: 'ups', trackingNumber: UPS_NUMBER },
          tx,
        );
        // The statement that would fail with 25P02 if the conflict had raised.
        const readBack = await findParcelByNumber('ups', UPS_NUMBER, tx);
        return { created: second.created, id: second.parcel.id, readBackId: readBack?.id };
      });

      expect(outcome.created).toBe(false);
      expect(outcome.readBackId).toBe(outcome.id);
    });

    it('treats a double-tapped add as one subscription', async () => {
      const first = await trackParcel('oxy-ana', { number: UPS_NUMBER });
      const second = await trackParcel('oxy-ana', { number: UPS_NUMBER });
      expect(second.id).toBe(first.id);
      expect((await parcelRow(UPS_NUMBER))?.subscriber_count).toBe(1);
    });
  });

  describe('re-ingesting a carrier history', () => {
    it('writes NOTHING the second time — asserted on the tuple, not the return', async () => {
      const { parcel } = await findOrCreateParcel({
        carrierKey: 'ups',
        trackingNumber: UPS_NUMBER,
      });
      const history = [
        {
          occurredAt: new Date('2026-03-01T09:00:00.000Z'),
          status: 'info_received' as const,
          rawStatus: 'LABEL_CREATED',
          locationText: 'MADRID',
        },
        {
          occurredAt: new Date('2026-03-01T14:00:00.000Z'),
          status: 'in_transit' as const,
          rawStatus: 'DEPARTED',
          locationText: 'MADRID HUB',
        },
      ];

      const first = await ingestCheckpoints(parcel.id, history);
      expect(first).toHaveLength(2);

      const [before] = await suite!.client<{ xmin: string }[]>`
        SELECT xmin::text AS xmin FROM tracking_checkpoints
        WHERE parcel_id = ${parcel.id} ORDER BY occurred_at LIMIT 1
      `;

      // Exactly what a carrier sends on the next poll: the whole history again.
      const second = await ingestCheckpoints(parcel.id, history);
      expect(second).toHaveLength(0);

      const [after] = await suite!.client<{ xmin: string; count: number }[]>`
        SELECT xmin::text AS xmin,
               (SELECT count(*)::int FROM tracking_checkpoints WHERE parcel_id = ${parcel.id}) AS count
        FROM tracking_checkpoints
        WHERE parcel_id = ${parcel.id} ORDER BY occurred_at LIMIT 1
      `;
      expect(after!.count).toBe(2);
      expect(after!.xmin).toBe(before!.xmin);
    });

    it('accepts a genuinely new event appended to a history it already has', async () => {
      const { parcel } = await findOrCreateParcel({
        carrierKey: 'ups',
        trackingNumber: UPS_NUMBER,
      });
      const first = {
        occurredAt: new Date('2026-03-01T09:00:00.000Z'),
        status: 'info_received' as const,
      };
      await ingestCheckpoints(parcel.id, [first]);

      const added = await ingestCheckpoints(parcel.id, [
        first,
        { occurredAt: new Date('2026-03-02T09:00:00.000Z'), status: 'out_for_delivery' as const },
      ]);
      expect(added).toHaveLength(1);
      expect(added[0]?.status).toBe('out_for_delivery');
    });

    it('survives a carrier repeating one event inside a single response', async () => {
      // Postgres refuses an INSERT whose own rows conflict with each other, even
      // under ON CONFLICT DO NOTHING. Without de-duping the batch this is a
      // runtime error rather than a no-op.
      const { parcel } = await findOrCreateParcel({
        carrierKey: 'ups',
        trackingNumber: UPS_NUMBER,
      });
      const event = { occurredAt: new Date('2026-03-01T09:00:00.000Z'), status: 'in_transit' as const };
      const rows = await ingestCheckpoints(parcel.id, [event, event, event]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('subscribing is what arms the poller', () => {
    it('gives an anonymous lookup a row with NO due time', async () => {
      // The whole anonymous cost story: one call, then nothing, ever.
      await lookupParcel({ number: CORREOS_NUMBER });
      const row = await parcelRow(CORREOS_NUMBER);
      expect(row).not.toBeNull();
      expect(row?.subscriber_count).toBe(0);
      expect(row?.next_poll_at).toBeNull();
    });

    it('does not arm a carrier we cannot call, even with a subscriber', async () => {
      // Every carrier is deep-link-only today, so this is the live case: the
      // CHECK would refuse a due time and the service must not try to set one.
      await trackParcel('oxy-ana', { number: UPS_NUMBER });
      expect((await parcelRow(UPS_NUMBER))?.next_poll_at).toBeNull();
    });

    it('disarms the parcel when the last watcher leaves', async () => {
      const tracked = await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await untrackParcel(tracked.id, 'oxy-ana');

      const row = await parcelRow(UPS_NUMBER);
      // The row survives as the shared cache; it just stops costing anything.
      expect(row).not.toBeNull();
      expect(row?.subscriber_count).toBe(0);
      expect(row?.next_poll_at).toBeNull();
    });

    it('leaves the parcel armed while somebody else is still watching', async () => {
      const ana = await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await trackParcel('oxy-bea', { number: UPS_NUMBER });
      await untrackParcel(ana.id, 'oxy-ana');
      expect((await parcelRow(UPS_NUMBER))?.subscriber_count).toBe(1);
    });
  });

  describe('correcting a wrong carrier', () => {
    it('re-points the subscription and never rewrites the parcel identity', async () => {
      // Mutating `carrier_key` would either collide with the real row or
      // silently rewrite a parcel other people are watching.
      const tracked = await trackParcel('oxy-ana', {
        number: '123456789012',
        carrierKey: 'fedex',
      });
      const moved = await updateParcel(tracked.id, 'oxy-ana', { carrierKey: 'dhl-express' });

      expect(moved.carrier.key).toBe('dhl-express');
      const [fedex] = await suite!.client<{ carrier_key: string; subscriber_count: number }[]>`
        SELECT carrier_key, subscriber_count FROM tracked_parcels WHERE carrier_key = 'fedex'
      `;
      expect(fedex?.carrier_key).toBe('fedex');
      expect(fedex?.subscriber_count).toBe(0);
    });
  });

  describe('scoping', () => {
    it("refuses another user's parcel as MISSING, not as forbidden", async () => {
      // A 403 would confirm the row exists, which is the enumeration this whole
      // surface is careful about.
      const tracked = await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await expect(getParcelDetail(tracked.id, 'oxy-bea')).rejects.toThrow(/not found/i);
    });

    it(`lists only the parcels belonging to the caller`, async () => {
      await trackParcel('oxy-ana', { number: UPS_NUMBER });
      await trackParcel('oxy-bea', { number: CORREOS_NUMBER });

      const ana = await listParcels('oxy-ana', { limit: 20, offset: 0 });
      expect(ana).toHaveLength(1);
      expect(ana[0]?.trackingNumber).toBe(UPS_NUMBER);
    });
  });
});

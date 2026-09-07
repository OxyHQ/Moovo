/**
 * The claim and the lease, against a real server.
 *
 * `FOR UPDATE SKIP LOCKED` cannot be tested against a mock: the whole point is
 * what the SERVER does when two workers reach for the same row, and a double
 * returns whatever it was told to.
 *
 * The sharpest case here is `renewParcelLease` reading a MATCH count rather
 * than a "did anything change" count. Two renewals inside one millisecond
 * compute an identical `lease_until`, so a renewal that held its lease
 * perfectly modifies no bytes. Spelled as "something changed" it reports a LOST
 * lease that was never lost — and the dispatcher answers a lost lease by
 * abandoning work mid-flight. The trap is documented at
 * `renewModerationOutboxRow`; it is re-implemented here, so it is re-tested
 * here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import {
  claimDueParcel,
  failParcelPoll,
  findParcelById,
  recordParcelNotFound,
  releaseParcelLease,
  renewParcelLease,
} from '../../../db/tracking/trackedParcelRepository.js';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const PAST = new Date('2020-01-01T00:00:00.000Z');
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

describeIfPostgres('the tracking poll claim', () => {
  let suite: SuiteDatabase | null = null;

  /** A pollable parcel, due now. `poll_supported` is irrelevant here — the
   * claim reads the parcel, and the carrier filter is the caller's job. */
  async function insertDueParcel(id: string, number: string, carrierKey = 'ups') {
    await suite!.client`INSERT INTO tracked_parcels ${suite!.client({
      id,
      carrier_key: carrierKey,
      tracking_number: number,
      subscriber_count: 1,
      next_poll_at: PAST.toISOString(),
      expires_at: FAR_FUTURE,
    })}`;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    for (const key of ['ups', 'fedex']) {
      await suite.client`
        INSERT INTO tracking_carriers (id, key, name, deep_link_template, poll_supported)
        VALUES (${`carrier-${key}`}, ${key}, ${key}, ${`https://x.invalid/${key}?n={number}`}, true)
      `;
    }
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  beforeEach(async () => {
    await suite!.client`DELETE FROM tracked_parcels`;
  });

  describe('claiming', () => {
    it('hands one parcel to exactly one worker', async () => {
      await insertDueParcel('p-1', 'AAA000000000001');

      const [first, second] = await Promise.all([
        claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] }),
        claimDueParcel({ leaseOwner: 'worker-b', leaseMs: 60_000, carrierKeys: ['ups'] }),
      ]);

      // SKIP LOCKED means the loser gets nothing rather than blocking — which
      // is what lets the dispatcher run on every task with no leader.
      const winners = [first, second].filter(Boolean);
      expect(winners).toHaveLength(1);
    });

    it('will not hand out a parcel somebody else still holds', async () => {
      await insertDueParcel('p-2', 'AAA000000000002');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });

      const second = await claimDueParcel({
        leaseOwner: 'worker-b',
        leaseMs: 60_000,
        carrierKeys: ['ups'],
      });
      expect(second).toBeNull();
    });

    it("reclaims a dead worker's parcel once the lease lapses", async () => {
      // The reason a lease is a lease and not a flag: a task that dies mid-poll
      // must not strand a parcel forever.
      await insertDueParcel('p-3', 'AAA000000000003');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });
      await suite!.client`
        UPDATE tracked_parcels SET lease_until = ${PAST.toISOString()} WHERE id = 'p-3'
      `;

      const reclaimed = await claimDueParcel({
        leaseOwner: 'worker-b',
        leaseMs: 60_000,
        carrierKeys: ['ups'],
      });
      expect(reclaimed?.id).toBe('p-3');
      expect(reclaimed?.leaseOwner).toBe('worker-b');
    });

    it('never claims a parcel with no due time', async () => {
      // Terminal, unwatched and deep-link parcels all sit here, and they are
      // the large majority of the table.
      await suite!.client`INSERT INTO tracked_parcels ${suite!.client({
        id: 'p-idle',
        carrier_key: 'ups',
        tracking_number: 'AAA000000000004',
        expires_at: FAR_FUTURE,
      })}`;
      expect(
        await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] }),
      ).toBeNull();
    });

    it('respects the carrier budget filter', async () => {
      // Carriers out of budget are excluded BEFORE the claim. Claiming and then
      // releasing would burn a lease cycle and reorder the queue.
      await insertDueParcel('p-fedex', 'AAA000000000005', 'fedex');
      expect(
        await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] }),
      ).toBeNull();
      expect(
        await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['fedex'] }),
      ).not.toBeNull();
    });

    it('claims nothing when no carrier has budget at all', async () => {
      await insertDueParcel('p-any', 'AAA000000000006');
      expect(
        await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: [] }),
      ).toBeNull();
    });
  });

  describe('renewing', () => {
    it('reports a HELD lease as held even when it changed no bytes', async () => {
      // THE trap. Two renewals in the same millisecond compute an identical
      // `lease_until`; a "did anything change" count would answer false and the
      // dispatcher would abandon a poll that was going perfectly.
      await insertDueParcel('p-renew', 'AAA000000000007');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });

      const at = new Date();
      expect(await renewParcelLease('p-renew', 'worker-a', 60_000, at)).toBe(true);
      // Identical `now`, so an identical `lease_until` — no bytes change.
      expect(await renewParcelLease('p-renew', 'worker-a', 60_000, at)).toBe(true);
    });

    it('refuses to renew a lease this worker does not hold', async () => {
      await insertDueParcel('p-other', 'AAA000000000008');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });
      expect(await renewParcelLease('p-other', 'worker-b', 60_000)).toBe(false);
    });

    it('refuses to renew a lease that has already lapsed', async () => {
      await insertDueParcel('p-lapsed', 'AAA000000000009');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });
      await suite!.client`
        UPDATE tracked_parcels SET lease_until = ${PAST.toISOString()} WHERE id = 'p-lapsed'
      `;
      expect(await renewParcelLease('p-lapsed', 'worker-a', 60_000)).toBe(false);
    });
  });

  describe('outcomes', () => {
    it('backs off and releases the lease after a carrier error', async () => {
      await insertDueParcel('p-fail', 'AAA000000000010');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });

      const soon = new Date(Date.now() + 60_000);
      await failParcelPoll('p-fail', { nextPollAt: soon, lastPollError: 'ECONNRESET' });

      const parcel = await findParcelById('p-fail');
      expect(parcel?.consecutiveFailures).toBe(1);
      expect(parcel?.lastPollError).toBe('ECONNRESET');
      // Released, so another worker can pick it up the moment it is due again.
      expect(parcel?.leaseOwner).toBeNull();
      expect(parcel?.leaseUntil).toBeNull();
    });

    it('truncates a carrier error rather than letting the CHECK reject the write', async () => {
      // A carrier returning an HTML error page would otherwise blow the 2000
      // char bound and lose the whole outcome, leaving the parcel leased.
      await insertDueParcel('p-long', 'AAA000000000011');
      await failParcelPoll('p-long', { nextPollAt: null, lastPollError: 'x'.repeat(5_000) });
      const parcel = await findParcelById('p-long');
      expect(parcel?.lastPollError?.length).toBe(2_000);
    });

    it('counts a not-found separately from a failure', async () => {
      // A label created and never scanned is the most common thing anyone
      // pastes into a tracker. Counted as a failure it would sit in error
      // backoff forever instead of expiring.
      await insertDueParcel('p-nf', 'AAA000000000012');
      await failParcelPoll('p-nf', { nextPollAt: new Date(), lastPollError: 'boom' });
      await recordParcelNotFound('p-nf', { nextPollAt: new Date() });

      const parcel = await findParcelById('p-nf');
      expect(parcel?.notFoundStreak).toBe(1);
      // A not-found is evidence the carrier ANSWERED, so the failure run ends.
      expect(parcel?.consecutiveFailures).toBe(0);
      expect(parcel?.lastPollError).toBeNull();
    });

    it('releases only a lease this worker holds', async () => {
      await insertDueParcel('p-rel', 'AAA000000000013');
      await claimDueParcel({ leaseOwner: 'worker-a', leaseMs: 60_000, carrierKeys: ['ups'] });

      await releaseParcelLease('p-rel', 'worker-b');
      expect((await findParcelById('p-rel'))?.leaseOwner).toBe('worker-a');

      await releaseParcelLease('p-rel', 'worker-a');
      expect((await findParcelById('p-rel'))?.leaseOwner).toBeNull();
    });
  });
});

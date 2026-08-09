/**
 * The expiry sweep — the replacement for five Mongo TTL indexes.
 *
 * The failure this file exists to catch is not "the sweep is broken". It is
 * "the sweep reaps MORE than it should", which produces no error, deletes real
 * user data, and is discovered months later when somebody notices their
 * notification history is empty.
 *
 * So every case asserts BOTH halves: the rows that must go are gone, and the
 * rows that must stay are still there. A sweep that deletes everything passes
 * the first half of every test in this file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findUnsupportedExpiryColumns } from '@oxyhq/db/assert';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';
import { EXPIRY_TARGETS, sweepExpiredRowsOnce } from '../expiry';
import { getDb } from '../postgres';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/** Every TTL index the Mongo models declare. If this grows, so must the registry. */
const EXPECTED_TARGET_COUNT = 5;

describeIfPostgres('the expiry sweep', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('registers one target per TTL index the source declared', () => {
    // A registry is the half of this that LOOKS complete while doing nothing,
    // so the count is pinned rather than left to inspection.
    expect(EXPIRY_TARGETS).toHaveLength(EXPECTED_TARGET_COUNT);
    expect(EXPIRY_TARGETS.every((target) => target.reason.trim().length > 0)).toBe(true);
  });

  it('has a supporting index behind every swept column', async () => {
    // Against the real catalogue, not the TypeScript that was meant to produce
    // it. Without a leading btree the sweep is a full table scan every run —
    // the cost Mongo's TTL index hid, now paid on a schedule.
    const violations = await findUnsupportedExpiryColumns(getDb(), EXPIRY_TARGETS);
    expect(violations).toEqual([]);
  });

  it('reaps a lapsed quote and leaves a live one', async () => {
    await suite!.client`
      INSERT INTO shipments (
        id, sender_oxy_user_id, type,
        pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
        pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
        dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
        dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
        parcel_weight_kg, parcel_size_class, item_description
      ) VALUES (
        'ship-q', 'oxy-sender', 'package',
        40.4, -3.7, 'A', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
        41.3, 2.1, 'B', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
        1, 'small', ''
      )
    `;
    for (const [id, expiresAt] of [
      ['q-lapsed', 'now() - interval \'1 hour\''],
      ['q-live', 'now() + interval \'1 hour\''],
    ] as const) {
      await suite!.client.unsafe(`
        INSERT INTO quotes (
          id, shipment_id, source, base_fair_minor, distance_fair_minor,
          size_fair_minor, total_fair_minor, expires_at
        ) VALUES ('${id}', 'ship-q', 'moovo_courier', 100, 200, 0, 300, ${expiresAt})
      `);
    }

    await sweepExpiredRowsOnce();

    const rows = await suite!.client<{ id: string }[]>`SELECT id FROM quotes ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual(['q-live']);
  });

  describe('notifications — the partial filter is the whole point', () => {
    beforeAll(async () => {
      // Four notifications, all older than the ninety-day retention. Only the
      // DISMISSED one may be reaped; the other three are the regression this
      // test exists for. A sweep keyed on `created_at` rather than
      // `dismissed_since` deletes all four and looks like housekeeping.
      for (const status of ['pending', 'sent', 'read', 'dismissed']) {
        await suite!.client.unsafe(`
          INSERT INTO notifications (id, oxy_user_id, type, title, body, status, created_at)
          VALUES ('n-${status}', 'oxy-1', 'order_paid', 't', 'b', '${status}',
                  now() - interval '200 days')
        `);
      }
    });

    it('reaps ONLY the dismissed one, however old the others are', async () => {
      await sweepExpiredRowsOnce();

      const rows = await suite!.client<{ id: string }[]>`
        SELECT id FROM notifications ORDER BY id
      `;
      // The three survivors are the assertion that matters. If this ever reads
      // `[]`, the partial filter has been lost and the sweep is deleting every
      // notification older than ninety days.
      expect(rows.map((row) => row.id)).toEqual(['n-pending', 'n-read', 'n-sent']);
    });

    it('keeps a RECENTLY dismissed notification until its retention elapses', async () => {
      await suite!.client`
        INSERT INTO notifications (id, oxy_user_id, type, title, body, status)
        VALUES ('n-just-dismissed', 'oxy-1', 'order_paid', 't', 'b', 'dismissed')
      `;
      await sweepExpiredRowsOnce();
      const rows = await suite!.client<{ id: string }[]>`
        SELECT id FROM notifications WHERE id = 'n-just-dismissed'
      `;
      expect(rows).toHaveLength(1);
    });

    it('takes a row back out of reach when it is un-dismissed', async () => {
      // The generated column tracks status changes, which a sweep argument
      // could not: un-dismissing returns `dismissed_since` to NULL.
      await suite!.client`
        UPDATE notifications SET status = 'read' WHERE id = 'n-just-dismissed'
      `;
      const [row] = await suite!.client<{ dismissed_since: Date | null }[]>`
        SELECT dismissed_since FROM notifications WHERE id = 'n-just-dismissed'
      `;
      expect(row?.dismissed_since).toBeNull();
    });
  });

  describe('job offers — the BACKSTOP reaps unconditionally', () => {
    it('reaps every offer past its expiry, whatever its status', async () => {
      // Deliberately NOT the `notifications` shape. That index carried a
      // partial filter; this one does not — Mongo reaps ANY offer past
      // `expiresAt`, and this is the bounded-growth backstop BEHIND the
      // semantic `offered → expired` flip.
      //
      // Narrowing it to already-flipped rows was tried and reverted: while the
      // flip runs both behave identically, and when it is wedged the narrowed
      // version keeps stale rows forever — removing the protection in the one
      // situation a backstop is for. A row past `expiresAt` is expired and
      // merely unflipped, not live.
      await suite!.client`
        INSERT INTO shipments (
          id, sender_oxy_user_id, type,
          pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
          pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
          dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
          dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
          parcel_weight_kg, parcel_size_class, item_description
        ) VALUES (
          'ship-o', 'oxy-sender', 'package',
          40.4, -3.7, 'A', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
          41.3, 2.1, 'B', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
          1, 'small', ''
        )
      `;
      await suite!.client`
        INSERT INTO jobs (
          id, job_number, shipment_id, sender_oxy_user_id, type, fulfillment_type,
          pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
          pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
          dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
          dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
          parcel_weight_kg, parcel_size_class, quote_snapshot, totals
        ) VALUES (
          'job-o', 'MOV-1', 'ship-o', 'oxy-sender', 'package', 'moovo_courier',
          40.4, -3.7, 'A', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
          41.3, 2.1, 'B', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
          1, 'small', '{}'::jsonb, '{}'::jsonb
        )
      `;
      await suite!.client.unsafe(`
        INSERT INTO job_offers (id, job_id, shipment_id, courier_oxy_user_id, status,
                                offered_at, expires_at, rank, distance_m)
        VALUES
          ('o-unflipped', 'job-o', 'ship-o', 'oxy-c1', 'offered',
           now() - interval '2 days', now() - interval '1 day', 1, 100),
          ('o-settled', 'job-o', 'ship-o', 'oxy-c2', 'declined',
           now() - interval '2 days', now() - interval '1 day', 2, 200),
          ('o-future', 'job-o', 'ship-o', 'oxy-c3', 'offered',
           now(), now() + interval '1 day', 3, 300)
      `);

      await sweepExpiredRowsOnce();

      const rows = await suite!.client<{ id: string }[]>`SELECT id FROM job_offers ORDER BY id`;
      // Both expired rows go — including the one still marked `offered`, which
      // is the backstop doing its job. The unexpired offer stays, which is what
      // stops this passing for a sweep that simply deletes everything.
      expect(rows.map((row) => row.id)).toEqual(['o-future']);
    });
  });

  it('reports what it deleted, so a sweep that reaps nothing is distinguishable', async () => {
    // A sweep that never ran and a sweep that found nothing produce the same
    // empty database. The result set is the only thing that tells them apart,
    // which is why the caller logs it.
    const results = await sweepExpiredRowsOnce();
    expect(results).toHaveLength(EXPECTED_TARGET_COUNT);
    expect(results.every((result) => typeof result.deleted === 'number')).toBe(true);
    expect(new Set(results.map((result) => result.table)).size).toBe(EXPECTED_TARGET_COUNT);
  });
});

/**
 * The constraints Moovo Tracker's cost and correctness actually rest on.
 *
 * Two of these are not ordinary validation and are the reason this file exists:
 *
 * **The dedupe.** `(carrier_key, tracking_number)` unique is the entire cost
 * design — a thousand watchers of one parcel must be one carrier call. Nothing
 * fails visibly when it is lost; the product keeps working and the bill
 * multiplies.
 *
 * **The normalisation CHECK, which is what keeps the dedupe true.** One
 * un-normalised write defeats the unique index: `1Z999AA1-0123456784` and
 * `1Z999AA10123456784` become two identities, two schedules and two bills. A
 * test that merely asserts "the row was inserted" cannot see it.
 *
 * Every rule is asserted in BOTH directions. A constraint that refuses
 * everything passes a suite made only of rejections, and refusing a legal row
 * is the more expensive failure: an outage, where a missing constraint is a
 * latent inconsistency.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/**
 * Comfortably in the future, so no test depends on the clock.
 *
 * ISO strings rather than `Date`s: `postgres.js`'s object-helper form
 * (``sql`INSERT INTO t ${sql(row)}` ``) serialises parameters itself and
 * refuses a `Date`, unlike the tagged-template form.
 */
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

describeIfPostgres('the tracking schema', () => {
  let suite: SuiteDatabase | null = null;

  async function insertCarrier(key: string, fields: Record<string, unknown> = {}) {
    await suite!.client`INSERT INTO tracking_carriers ${suite!.client({
      id: `carrier-${key}`,
      key,
      name: key.toUpperCase(),
      deep_link_template: `https://example.invalid/${key}?n={number}`,
      ...fields,
    })}`;
  }

  /** A parcel with every NOT NULL column filled, overridden by `fields`. */
  async function insertParcel(id: string, fields: Record<string, unknown> = {}) {
    await suite!.client`INSERT INTO tracked_parcels ${suite!.client({
      id,
      carrier_key: 'ups',
      tracking_number: `1Z999AA1012345678${id.length}`,
      expires_at: FAR_FUTURE,
      ...fields,
    })}`;
  }

  async function insertCheckpoint(id: string, fields: Record<string, unknown> = {}) {
    await suite!.client`INSERT INTO tracking_checkpoints ${suite!.client({
      id,
      parcel_id: 'p-base',
      dedupe_key: id,
      status: 'in_transit',
      occurred_at: '2026-03-01T10:00:00.000Z',
      received_at: '2026-03-01T10:05:00.000Z',
      ...fields,
    })}`;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    await insertCarrier('ups', { source_kind: 'official_api', poll_supported: true });
    await insertCarrier('fedex', { source_kind: 'official_api', poll_supported: true });
    await insertCarrier('mrw', { source_kind: 'deep_link_only' });
    // NOT inserted here: `moovo` arrives with migration 0004, because booking a
    // job writes a pointer row against it inside the job's own transaction and
    // a missing carrier would fail the foreign key — and therefore the booking.
    await insertParcel('p-base');
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  describe('tracked_parcels — the number is normalised, or it is refused', () => {
    it('accepts a normalised number', async () => {
      await expect(
        insertParcel('p-ok', { tracking_number: '1Z999AA10123456784' }),
      ).resolves.toBeUndefined();
    });

    it('refuses a number carrying the separators a carrier prints', async () => {
      // The exact shape that silently doubles the carrier bill.
      await expect(
        insertParcel('p-hyphen', { tracking_number: '1Z999AA1-0123456784' }),
      ).rejects.toThrow(/tracked_parcels_number_normalised_check/);
    });

    it('refuses a lowercase number', async () => {
      await expect(
        insertParcel('p-lower', { tracking_number: '1z999aa10123456785' }),
      ).rejects.toThrow(/tracked_parcels_number_normalised_check/);
    });

    it('refuses a number padded with the whitespace a paste carries', async () => {
      await expect(
        insertParcel('p-space', { tracking_number: ' 1Z999AA10123456786' }),
      ).rejects.toThrow(/tracked_parcels_number_normalised_check/);
    });
  });

  describe('tracked_parcels — one identity per (carrier, number)', () => {
    it('refuses a second identity for the same number on the same carrier', async () => {
      await insertParcel('p-dupe-1', { tracking_number: 'JJD000390009999999' });
      await expect(
        insertParcel('p-dupe-2', { tracking_number: 'JJD000390009999999' }),
      ).rejects.toThrow(/tracked_parcels_carrier_number_key/);
    });

    it('accepts the same number on a DIFFERENT carrier', async () => {
      // Tracking numbers are not globally unique; two carriers can legitimately
      // issue the same string. The identity is the pair, never the number.
      await expect(
        insertParcel('p-other-carrier', {
          carrier_key: 'fedex',
          tracking_number: 'JJD000390009999999',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('tracked_parcels — a carrier we cannot call is never scheduled', () => {
    it('accepts a deep-link parcel with no due time', async () => {
      await expect(
        insertParcel('p-deeplink', {
          carrier_key: 'mrw',
          tracking_number: 'MRW000000000001',
          poll_mode: 'deeplink',
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses a deep-link parcel that has been scheduled for a fetch', async () => {
      await expect(
        insertParcel('p-deeplink-due', {
          carrier_key: 'mrw',
          tracking_number: 'MRW000000000002',
          poll_mode: 'deeplink',
          next_poll_at: FAR_FUTURE,
        }),
      ).rejects.toThrow(/tracked_parcels_deeplink_no_poll_check/);
    });

    it('accepts a pollable parcel that has been scheduled', async () => {
      await expect(
        insertParcel('p-due', {
          tracking_number: '1Z999AA10123456787',
          next_poll_at: FAR_FUTURE,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('tracked_parcels — a job pointer belongs to the moovo carrier', () => {
    it('refuses a job pointer on a real carrier', async () => {
      // The CHECK is evaluated during the insert, ahead of the foreign key,
      // which is an AFTER trigger — so this reports the shape violation rather
      // than a missing job.
      await expect(
        insertParcel('p-bad-job', {
          tracking_number: '1Z999AA10123456788',
          moovo_job_id: 'job-nonexistent',
        }),
      ).rejects.toThrow(/tracked_parcels_moovo_job_shape_check/);
    });

    it('accepts a pointer to a real job under the moovo carrier', async () => {
      await suite!.client`
        INSERT INTO shipments (
          id, sender_oxy_user_id, type,
          pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
          pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
          dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
          dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
          parcel_weight_kg, parcel_size_class, item_description
        ) VALUES (
          'ship-track', 'oxy-sender', 'package',
          40.4168, -3.7038, 'Calle Mayor 1', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
          41.3851, 2.1734, 'Carrer Gran 2', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
          2.5, 'small', ''
        )
      `;
      await suite!.client`INSERT INTO jobs ${suite!.client({
        id: 'job-track',
        job_number: 'MOV-000042',
        shipment_id: 'ship-track',
        sender_oxy_user_id: 'oxy-sender',
        type: 'package',
        fulfillment_type: 'moovo_courier',
        pickup_latitude: 40.4168,
        pickup_longitude: -3.7038,
        pickup_line1: 'Calle Mayor 1',
        pickup_city: 'Madrid',
        pickup_postal_code: '28013',
        pickup_country: 'ES',
        pickup_contact_name: 'Ana',
        pickup_contact_phone: '+34600000000',
        dropoff_latitude: 41.3851,
        dropoff_longitude: 2.1734,
        dropoff_line1: 'Carrer Gran 2',
        dropoff_city: 'Barcelona',
        dropoff_postal_code: '08001',
        dropoff_country: 'ES',
        dropoff_contact_name: 'Bea',
        dropoff_contact_phone: '+34600000001',
        parcel_weight_kg: 2.5,
        parcel_size_class: 'small',
        quote_snapshot: JSON.stringify({ total: { fairMinor: 300 } }),
        totals: JSON.stringify({ total: { fairMinor: 300 } }),
      })}`;

      await expect(
        insertParcel('p-moovo', {
          carrier_key: 'moovo',
          tracking_number: 'MOV000042',
          poll_mode: 'manual',
          moovo_job_id: 'job-track',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('tracking_checkpoints — a re-sent history writes nothing twice', () => {
    it('refuses the same event twice on one parcel', async () => {
      await insertCheckpoint('cp-1');
      await expect(insertCheckpoint('cp-1-again', { dedupe_key: 'cp-1' })).rejects.toThrow(
        /tracking_checkpoints_dedupe_key/,
      );
    });

    it('accepts the same event key on a DIFFERENT parcel', async () => {
      // The key is content-derived, so two parcels scanned at the same depot in
      // the same second can legitimately produce it.
      await insertParcel('p-cp-other', { tracking_number: '1Z999AA10123456789' });
      await expect(
        insertCheckpoint('cp-other', { parcel_id: 'p-cp-other', dedupe_key: 'cp-1' }),
      ).resolves.toBeUndefined();
    });

    it('refuses half a coordinate', async () => {
      await expect(insertCheckpoint('cp-halflat', { latitude: 40.4 })).rejects.toThrow(
        /tracking_checkpoints_location_shape_check/,
      );
    });

    it('accepts a checkpoint with no coordinates at all', async () => {
      // The common case: most carriers report a place name and no position, and
      // absent must stay genuinely absent rather than becoming (0, 0).
      await expect(insertCheckpoint('cp-nogeo')).resolves.toBeUndefined();
      const [row] = await suite!.client<{ location: string | null }[]>`
        SELECT location FROM tracking_checkpoints WHERE id = 'cp-nogeo'
      `;
      expect(row?.location).toBeNull();
    });
  });

  describe('tracked_parcel_subscriptions — many watchers, one parcel', () => {
    it('refuses the same user adding one parcel twice', async () => {
      await suite!.client`INSERT INTO tracked_parcel_subscriptions ${suite!.client({
        id: 'sub-1',
        parcel_id: 'p-base',
        oxy_user_id: 'oxy-ana',
        entered_number: '1Z999AA1 0123456784',
      })}`;
      await expect(
        suite!.client`INSERT INTO tracked_parcel_subscriptions ${suite!.client({
          id: 'sub-1-again',
          parcel_id: 'p-base',
          oxy_user_id: 'oxy-ana',
          entered_number: '1Z999AA10123456784',
        })}`,
      ).rejects.toThrow(/tracked_parcel_subscriptions_user_parcel_key/);
    });

    it('lets two users watch one parcel — and that stays ONE parcel row', async () => {
      // The cost property, asserted as a property rather than inferred from the
      // index definition.
      await suite!.client`INSERT INTO tracked_parcel_subscriptions ${suite!.client({
        id: 'sub-2',
        parcel_id: 'p-base',
        oxy_user_id: 'oxy-bea',
        entered_number: '1Z999AA10123456784',
      })}`;

      const [parcels] = await suite!.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM tracked_parcels WHERE id = 'p-base'
      `;
      const [subs] = await suite!.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM tracked_parcel_subscriptions WHERE parcel_id = 'p-base'
      `;
      expect(parcels?.count).toBe(1);
      expect(subs?.count).toBe(2);
    });
  });
});

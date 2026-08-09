/**
 * The CHECK constraints that replace the four `pre('validate')` hooks — and
 * the two the source never had.
 *
 * A hook could never actually hold the invariant it claimed: two concurrent
 * writes both passed it and both saved, because nothing serialised them. The
 * constraint is the enforcement, which is why the rules are NOT also
 * re-expressed at a write chokepoint — doing both looks like belt-and-braces
 * and merely restores the race, while making it look handled.
 *
 * Each rule is tested in BOTH directions. A constraint that rejects everything
 * would pass a suite that only asserts rejections, and a legal row being
 * refused is the more expensive failure: it is an outage, where a missing
 * constraint is a latent inconsistency.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

describeIfPostgres('the CHECK constraints that replace the hooks', () => {
  let suite: SuiteDatabase | null = null;

  /** A shipment, so jobs have something to reference. Returns its id. */
  async function insertShipment(id: string): Promise<string> {
    await suite!.client`
      INSERT INTO shipments (
        id, sender_oxy_user_id, type,
        pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
        pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
        dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
        dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
        parcel_weight_kg, parcel_size_class, item_description
      ) VALUES (
        ${id}, 'oxy-sender', 'package',
        40.4168, -3.7038, 'Calle Mayor 1', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
        41.3851, 2.1734, 'Carrer Gran 2', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
        2.5, 'small', ''
      )
    `;
    return id;
  }

  /** A job with every NOT NULL column filled, overridden by `fields`. */
  async function insertJob(id: string, shipmentId: string, fields: Record<string, unknown>) {
    const base: Record<string, unknown> = {
      id,
      job_number: id,
      shipment_id: shipmentId,
      sender_oxy_user_id: 'oxy-sender',
      type: 'package',
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
      ...fields,
    };
    await suite!.client`INSERT INTO jobs ${suite!.client(base)}`;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    await suite.client`
      INSERT INTO stores (id, handle, name, description, brand_color) VALUES ('store-1', 'shop', 'Shop', '', '#000')
    `;
    await suite.client`
      INSERT INTO courier_companies (id, handle, name, description, brand_color)
      VALUES ('company-1', 'fleet', 'Fleet', '', '#000')
    `;
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  describe('listings — ownerType is user XOR store', () => {
    it('accepts a user-owned listing', async () => {
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, oxy_user_id, title, condition, description)
          VALUES ('l-user', 'user', 'oxy-1', 'A bike', 'used', '')
        `,
      ).resolves.toBeDefined();
    });

    it('accepts a store-owned listing', async () => {
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, store_id, title, condition, description)
          VALUES ('l-store', 'store', 'store-1', 'A lamp', 'new', '')
        `,
      ).resolves.toBeDefined();
    });

    it('refuses a user-owned listing with no owner', async () => {
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, title, condition, description)
          VALUES ('l-bad-1', 'user', 'Orphan', 'used', '')
        `,
      ).rejects.toThrow(/listings_owner_shape_check/);
    });

    it('refuses a listing owned BOTH ways — the race the hook could not stop', async () => {
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, oxy_user_id, store_id, title, condition, description)
          VALUES ('l-bad-2', 'user', 'oxy-1', 'store-1', 'Both', 'used', '')
        `,
      ).rejects.toThrow(/listings_owner_shape_check/);
    });

    it('refuses a condition outside the closed set', async () => {
      // Tested on `condition` rather than `ownerType` deliberately. An invalid
      // `ownerType` violates the enum check AND the shape check at once — the
      // shape check enumerates the two legal owner types, so no third value can
      // satisfy it — and Postgres does not guarantee WHICH of two violated
      // constraints it names. `condition` is covered by exactly one, so this
      // asserts the closed-set constraint itself rather than a race between
      // two error messages.
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, oxy_user_id, title, condition, description)
          VALUES ('l-bad-3', 'user', 'oxy-1', 'Other', 'refurbished', '')
        `,
      ).rejects.toThrow(/listings_condition_check/);
    });

    it('refuses an ownerType outside the closed set', async () => {
      // Refused by one of the two overlapping constraints; which one is not
      // guaranteed, so the assertion names both rather than pinning a
      // behaviour Postgres never promised.
      await expect(
        suite!.client`
          INSERT INTO listings (id, owner_type, oxy_user_id, title, condition, description)
          VALUES ('l-bad-4', 'cooperative', 'oxy-1', 'Other', 'used', '')
        `,
      ).rejects.toThrow(/listings_owner_type_check|listings_owner_shape_check/);
    });
  });

  describe('vehicles — ownerType is courier XOR company', () => {
    it('accepts a courier-owned vehicle', async () => {
      await expect(
        suite!.client`
          INSERT INTO vehicles (id, owner_type, courier_oxy_user_id, type)
          VALUES ('v-courier', 'courier', 'oxy-2', 'bike')
        `,
      ).resolves.toBeDefined();
    });

    it('accepts a company-owned vehicle', async () => {
      await expect(
        suite!.client`
          INSERT INTO vehicles (id, owner_type, company_id, type)
          VALUES ('v-company', 'company', 'company-1', 'van')
        `,
      ).resolves.toBeDefined();
    });

    it('refuses a company vehicle that also names a courier', async () => {
      await expect(
        suite!.client`
          INSERT INTO vehicles (id, owner_type, company_id, courier_oxy_user_id, type)
          VALUES ('v-bad', 'company', 'company-1', 'oxy-2', 'van')
        `,
      ).rejects.toThrow(/vehicles_owner_shape_check/);
    });
  });

  describe('jobs — the ASYMMETRIC rule, where an unassigned job is legal', () => {
    it('accepts a moovo_courier job with NO courier assigned', async () => {
      // The state every job passes through between `requested` and `accepted`.
      // Modelling this rule as the symmetric owner split `listings` uses would
      // forbid it — which is the whole reason it is written out separately.
      const shipment = await insertShipment('s-unassigned');
      await expect(
        insertJob('j-unassigned', shipment, { fulfillment_type: 'moovo_courier' }),
      ).resolves.toBeUndefined();
    });

    it('accepts a moovo_courier job WITH a courier assigned', async () => {
      const shipment = await insertShipment('s-assigned');
      await expect(
        insertJob('j-assigned', shipment, {
          fulfillment_type: 'moovo_courier',
          courier_oxy_user_id: 'oxy-courier',
        }),
      ).resolves.toBeUndefined();
    });

    it('accepts a moovo_courier job carrying a company', async () => {
      // `moovo_courier` constrains NOTHING but `providerRef`.
      const shipment = await insertShipment('s-company');
      await expect(
        insertJob('j-company', shipment, {
          fulfillment_type: 'moovo_courier',
          company_id: 'company-1',
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses a moovo_courier job that names a provider', async () => {
      const shipment = await insertShipment('s-provider-bad');
      await expect(
        insertJob('j-provider-bad', shipment, {
          fulfillment_type: 'moovo_courier',
          provider_ref: 'DHL-123',
        }),
      ).rejects.toThrow(/jobs_fulfillment_shape_check/);
    });

    it('accepts an external_provider job with a provider reference', async () => {
      const shipment = await insertShipment('s-external');
      await expect(
        insertJob('j-external', shipment, {
          fulfillment_type: 'external_provider',
          provider_ref: 'DHL-123',
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses an external_provider job with no provider reference', async () => {
      const shipment = await insertShipment('s-external-bad');
      await expect(
        insertJob('j-external-bad', shipment, { fulfillment_type: 'external_provider' }),
      ).rejects.toThrow(/jobs_fulfillment_shape_check/);
    });

    it('refuses an external_provider job that also names a courier', async () => {
      const shipment = await insertShipment('s-external-courier');
      await expect(
        insertJob('j-external-courier', shipment, {
          fulfillment_type: 'external_provider',
          provider_ref: 'DHL-123',
          courier_oxy_user_id: 'oxy-courier',
        }),
      ).rejects.toThrow(/jobs_fulfillment_shape_check/);
    });
  });

  describe('shipments — scheduling kind and its time', () => {
    it('accepts a `now` shipment with no scheduled time', async () => {
      await expect(insertShipment('s-now')).resolves.toBeDefined();
    });

    it('accepts a `scheduled` shipment that carries a time', async () => {
      await insertShipment('s-sched');
      await expect(
        suite!.client`
          UPDATE shipments SET scheduling_kind = 'scheduled', scheduled_for = now()
          WHERE id = 's-sched'
        `,
      ).resolves.toBeDefined();
    });

    it('refuses a `scheduled` shipment with no time', async () => {
      await insertShipment('s-sched-bad');
      await expect(
        suite!.client`UPDATE shipments SET scheduling_kind = 'scheduled' WHERE id = 's-sched-bad'`,
      ).rejects.toThrow(/shipments_scheduling_shape_check/);
    });

    it('refuses a `now` shipment that carries a time', async () => {
      await insertShipment('s-now-bad');
      await expect(
        suite!.client`UPDATE shipments SET scheduled_for = now() WHERE id = 's-now-bad'`,
      ).rejects.toThrow(/shipments_scheduling_shape_check/);
    });

    it('refuses an unknown kind, which the hook itself never did', async () => {
      // The source hook has no else-branch: an unrecognised `kind` was rejected
      // by the field's ENUM, never by the hook. So the enum constraint has to
      // exist separately here — the shape check must not be read as inheriting
      // a rejection the hook never performed.
      //
      // Both constraints are violated by an unknown kind (the shape check
      // enumerates the two legal kinds, so no third value satisfies it), and
      // Postgres does not guarantee which of two it reports. The assertion
      // names both rather than depending on evaluation order that could flip
      // on any server version.
      await insertShipment('s-kind-bad');
      await expect(
        suite!.client`UPDATE shipments SET scheduling_kind = 'eventually' WHERE id = 's-kind-bad'`,
      ).rejects.toThrow(/shipments_scheduling_kind_check|shipments_scheduling_shape_check/);
    });
  });

  describe('orders — a constraint the source never had at the database', () => {
    it('accepts a store-sold order', async () => {
      await expect(
        suite!.client`
          INSERT INTO orders (
            id, order_number, buyer_oxy_user_id, seller_type, store_id,
            ship_to_recipient_name, ship_to_line1, ship_to_city, ship_to_postal_code,
            ship_to_country, shipping_method, shipping_label,
            shipping_cost_amount, shipping_cost_currency,
            subtotal_amount, subtotal_currency, grand_total_amount, grand_total_currency,
            checkout_group_id
          ) VALUES (
            'o-store', 'MRC-000001', 'oxy-buyer', 'store', 'store-1',
            'Ana', 'Calle Mayor 1', 'Madrid', '28013', 'ES', 'standard', 'Standard',
            0, 'EUR', 1000, 'EUR', 1000, 'EUR', 'cg-1'
          )
        `,
      ).resolves.toBeDefined();
    });

    it('refuses an order that names both a seller and a store', async () => {
      await expect(
        suite!.client`
          INSERT INTO orders (
            id, order_number, buyer_oxy_user_id, seller_type, store_id, seller_oxy_user_id,
            ship_to_recipient_name, ship_to_line1, ship_to_city, ship_to_postal_code,
            ship_to_country, shipping_method, shipping_label,
            shipping_cost_amount, shipping_cost_currency,
            subtotal_amount, subtotal_currency, grand_total_amount, grand_total_currency,
            checkout_group_id
          ) VALUES (
            'o-bad', 'MRC-000002', 'oxy-buyer', 'store', 'store-1', 'oxy-seller',
            'Ana', 'Calle Mayor 1', 'Madrid', '28013', 'ES', 'standard', 'Standard',
            0, 'EUR', 1000, 'EUR', 1000, 'EUR', 'cg-2'
          )
        `,
      ).rejects.toThrow(/orders_seller_shape_check/);
    });
  });

  describe('reports.decision_revision — a guard that could not exist in Mongo', () => {
    // `IReport` declares `decisionRevision` and `moderation-decision.worker.ts`
    // `$set`s it, but `ReportSchema` declares no such path — so mongoose's
    // strict mode strips it from every update and the field is structurally
    // unwritable. Proven through the raw driver, and the consequence proven
    // too: the worker's `$or: [{$exists:false}, {$lt:N}]` filter always takes
    // the first branch, so a STALE decision matches and overwrites a newer one.
    // The guard its own doc comment describes has never once held.
    //
    // It went unnoticed because `moderation-decision.worker.test.ts` mocks
    // `Report.updateOne` and asserts only the SHAPE of the filter — passing
    // happily while the server threw the field away. Hence a REAL database
    // here: a mocked write accepts statements a real server does not.
    it('stores the revision, and refuses an out-of-order decision', async () => {
      await suite!.client`
        INSERT INTO reports (id, reporter, reported_type, reported_id, categories, decision_revision)
        VALUES ('r-1', 'oxy-reporter', 'courier', 'oxy-courier', ARRAY['harassment'], 6)
      `;

      // Revision 3 arriving after 6 — the exact stale-delivery case.
      const stale = await suite!.client`
        UPDATE reports SET status = 'resolved', decision_revision = 3
        WHERE id = 'r-1' AND (decision_revision IS NULL OR decision_revision < 3)
      `;
      expect(stale.count).toBe(0);

      const [unchanged] = await suite!.client<{ decision_revision: number; status: string }[]>`
        SELECT decision_revision, status FROM reports WHERE id = 'r-1'
      `;
      expect(unchanged?.decision_revision).toBe(6);
      expect(unchanged?.status).toBe('pending');

      // A NEWER revision still applies, so the guard is not simply refusing
      // everything — the failure mode that would pass a rejection-only test.
      const fresh = await suite!.client`
        UPDATE reports SET status = 'resolved', decision_revision = 7
        WHERE id = 'r-1' AND (decision_revision IS NULL OR decision_revision < 7)
      `;
      expect(fresh.count).toBe(1);
    });

    it('admits the first decision for a backfilled row, then guards it', async () => {
      // The backfill leaves `decision_revision` NULL: those decisions were
      // applied unguarded and their revisions cannot be reconstructed. The
      // `IS NULL` branch admits the next decision once, and guards after.
      await suite!.client`
        INSERT INTO reports (id, reporter, reported_type, reported_id, categories)
        VALUES ('r-2', 'oxy-reporter-2', 'courier', 'oxy-courier', ARRAY['harassment'])
      `;
      const first = await suite!.client`
        UPDATE reports SET decision_revision = 4
        WHERE id = 'r-2' AND (decision_revision IS NULL OR decision_revision < 4)
      `;
      expect(first.count).toBe(1);

      const second = await suite!.client`
        UPDATE reports SET decision_revision = 2
        WHERE id = 'r-2' AND (decision_revision IS NULL OR decision_revision < 2)
      `;
      expect(second.count).toBe(0);
    });
  });
});

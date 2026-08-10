/**
 * `shipments` and `quotes` against a real PostgreSQL server.
 *
 * The rest of this backend's transport tests mock their repositories, which is
 * right for logic and blind to everything measured here. Each of these is a
 * property no mock has:
 *
 *  - **The nested↔flat round trip.** `shipments` flattens two endpoints and a
 *    parcel into ~30 columns and the whole application reads them nested. A
 *    mapper that drops `line2`, swaps two ordinates or loses `fragile` produces
 *    a perfectly valid row and a subtly wrong shipment; only writing one and
 *    reading it back compares the two shapes.
 *  - **The generated geography point.** `pickup_location` is `GENERATED ALWAYS`
 *    from the ordinate pair. Nothing in TypeScript can check that the pair
 *    reaches it in the order `ST_MakePoint` expects.
 *  - **The CAS predicate on the status flip.** `markShipmentQuoted` refuses a
 *    booked shipment. No caller reads its row count, so the guard is the ENTIRE
 *    content of that statement — remove it and every happy path still passes.
 *  - **The transaction actually being joined.** A repository that reached for
 *    `getDb()` instead of using the handle it was passed would type-check,
 *    commit outside the caller's block, and lose atomicity silently.
 *  - **`count()` decoding.** postgres.js returns `int8` as a STRING, and the
 *    value flows into a `total: number` on the paginated response.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PriceBreakdown } from '@moovo/shared-types';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import {
  countShipmentsForSender,
  findShipmentById,
  findShipmentModerationFacts,
  insertShipment,
  listShipmentsForSender,
  markShipmentBooked,
  markShipmentCancelled,
  markShipmentQuoted,
  updateShipmentDistance,
} from '../shipmentRepository';
import {
  findQuoteById,
  insertQuotes,
  listActiveQuotesForShipment,
  markQuoteSelected,
} from '../quoteRepository';
import type { NewShipment } from '../shipmentShape';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/**
 * The suite's raw client, non-optionally.
 *
 * A tagged template may not appear in an optional chain, so `suite?.client\`…\``
 * is a parse error rather than a lint preference — hence an accessor that
 * refuses instead of a `!`.
 */
function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** The suite's drizzle handle, non-optionally. */
function database(): SuiteDatabase['db'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.db;
}

let suite: SuiteDatabase | null = null;

/** Barcelona and Girona, `[lng, lat]` in GeoJSON order. */
const BARCELONA: readonly [number, number] = [2.1734, 41.3851];
const GIRONA: readonly [number, number] = [2.8249, 41.9794];

/** A shipment with EVERY optional present — the shape a lossy mapper drops. */
function fullShipment(overrides: Partial<NewShipment> = {}): NewShipment {
  return {
    senderOxyUserId: 'sender-full',
    type: 'package',
    status: 'quoting',
    pickup: {
      location: { type: 'Point', coordinates: [...BARCELONA] },
      address: {
        line1: 'Carrer de Mallorca 401',
        line2: 'Escala B, 3r 2a',
        city: 'Barcelona',
        region: 'Catalunya',
        postalCode: '08013',
        country: 'ES',
      },
      contactName: 'Anna Puig',
      contactPhone: '+34600111222',
      notes: 'Buzzer is broken, call on arrival',
    },
    dropoff: {
      location: { type: 'Point', coordinates: [...GIRONA] },
      address: {
        line1: 'Plaça de la Independència 12',
        line2: 'Baixos',
        city: 'Girona',
        region: 'Catalunya',
        postalCode: '17001',
        country: 'ES',
      },
      contactName: 'Marc Roca',
      contactPhone: '+34600333444',
      notes: 'Leave with the concierge',
    },
    parcel: {
      weightKg: 4.25,
      dimsCm: { l: 40, w: 30, h: 20 },
      sizeClass: 'medium',
      pieces: 3,
      fragile: true,
    },
    itemDescription: 'A sealed cardboard box',
    photos: [
      { fileId: 'file-a', alt: 'front', position: 0 },
      { fileId: 'file-b', position: 1 },
    ],
    scheduling: { kind: 'scheduled', scheduledFor: new Date('2026-09-01T10:00:00.000Z') },
    ...overrides,
  };
}

/** A shipment with EVERY optional absent — the other half of the round trip. */
function minimalShipment(overrides: Partial<NewShipment> = {}): NewShipment {
  return {
    senderOxyUserId: 'sender-minimal',
    type: 'food',
    status: 'quoting',
    pickup: {
      location: { type: 'Point', coordinates: [...BARCELONA] },
      address: { line1: 'A 1', city: 'Barcelona', postalCode: '08001', country: 'ES' },
      contactName: 'A',
      contactPhone: '+34600000001',
    },
    dropoff: {
      location: { type: 'Point', coordinates: [...GIRONA] },
      address: { line1: 'B 2', city: 'Girona', postalCode: '17001', country: 'ES' },
      contactName: 'B',
      contactPhone: '+34600000002',
    },
    parcel: { weightKg: 1, sizeClass: 'small', pieces: 1 },
    itemDescription: 'A paper bag',
    photos: [],
    scheduling: { kind: 'now' },
    ...overrides,
  };
}

function breakdown(total: number): PriceBreakdown {
  return {
    base: { fairMinor: 100, originalCurrency: 'FAIR' },
    distance: { fairMinor: total - 150, originalCurrency: 'FAIR' },
    size: { fairMinor: 50, originalCurrency: 'FAIR' },
    total: { fairMinor: total, originalCurrency: 'FAIR' },
  };
}

describeIfPostgres('shipments and quotes on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    // Quotes cascade from shipments, so one delete clears both.
    await client()`DELETE FROM shipments`;
  });

  describe('the nested↔flat round trip', () => {
    it('returns every field of a fully-populated shipment unchanged', async () => {
      const input = fullShipment();
      const created = await insertShipment(input);
      const read = await findShipmentById(created.id);

      expect(read).not.toBeNull();
      // Compared as WHOLE value objects rather than field by field: a
      // field-at-a-time comparison silently stops covering anything added later.
      expect(read?.pickup).toEqual(input.pickup);
      expect(read?.dropoff).toEqual(input.dropoff);
      expect(read?.parcel).toEqual(input.parcel);
      expect(read?.photos).toEqual(input.photos);
      expect(read?.scheduling).toEqual(input.scheduling);
      expect(read?.itemDescription).toBe(input.itemDescription);
      expect(read?.senderOxyUserId).toBe(input.senderOxyUserId);
      expect(read?.type).toBe(input.type);
    });

    /**
     * An absent optional comes back ABSENT, not null.
     *
     * The columns are nullable and the DTO contract distinguishes a missing key
     * from a present one — `"line2": null` is not something the wire contract
     * describes, and `redaction.ts` and the hydrators both test these for
     * truthiness. `toEqual` ignores undefined keys, so the key SET is asserted
     * explicitly.
     */
    it('omits absent optionals rather than returning nulls', async () => {
      const created = await insertShipment(minimalShipment());
      const read = await findShipmentById(created.id);

      expect(Object.keys(read?.pickup.address ?? {}).sort()).toEqual([
        'city',
        'country',
        'line1',
        'postalCode',
      ]);
      expect(read?.pickup).not.toHaveProperty('notes');
      expect(read?.parcel).not.toHaveProperty('dimsCm');
      expect(read?.scheduling).toEqual({ kind: 'now' });
      expect(read).not.toHaveProperty('distanceM');
      expect(read).not.toHaveProperty('quoteRef');
      expect(read).not.toHaveProperty('jobId');
    });

    /**
     * `dimsCm` is all three ordinates or none.
     *
     * Three nullable columns can express a partial `{l, w}`, which the source's
     * optional subdocument could not. The reassembly refuses it, so a row
     * carrying two of three reads as no dimensions rather than as dimensions
     * with a missing height that some consumer treats as zero.
     */
    it('reads a partially-populated dimension triple as no dimensions at all', async () => {
      const created = await insertShipment(minimalShipment());
      await client()`
        UPDATE shipments SET parcel_dims_l = 40, parcel_dims_w = 30 WHERE id = ${created.id}
      `;

      const read = await findShipmentById(created.id);
      expect(read?.parcel).not.toHaveProperty('dimsCm');
    });
  });

  /**
   * The generated point agrees with the ordinates it was generated from.
   *
   * `geo.realdb.test.ts` measures this for `courier_profiles`; `shipments`
   * declares the same helper twice more, and a helper used correctly in one
   * table and backwards in another is exactly the mistake that survives review.
   * `ST_X` is longitude and `ST_Y` is latitude — a swap puts a Barcelona pickup
   * in the Indian Ocean and raises nothing.
   */
  it('generates both endpoint points in (lng, lat) order', async () => {
    const created = await insertShipment(fullShipment());

    const [row] = await client()<
      Array<{ px: number; py: number; dx: number; dy: number }>
    >`
      SELECT ST_X(pickup_location::geometry) AS px, ST_Y(pickup_location::geometry) AS py,
             ST_X(dropoff_location::geometry) AS dx, ST_Y(dropoff_location::geometry) AS dy
      FROM shipments WHERE id = ${created.id}
    `;

    expect(row?.px).toBeCloseTo(BARCELONA[0], 6);
    expect(row?.py).toBeCloseTo(BARCELONA[1], 6);
    expect(row?.dx).toBeCloseTo(GIRONA[0], 6);
    expect(row?.dy).toBeCloseTo(GIRONA[1], 6);
  });

  describe('the status flip is a compare-and-swap', () => {
    it('flips a quoting shipment to quoted', async () => {
      const created = await insertShipment(minimalShipment({ status: 'quoting' }));
      await markShipmentQuoted(created.id);
      expect((await findShipmentById(created.id))?.status).toBe('quoted');
    });

    it('flips a draft shipment to quoted', async () => {
      const created = await insertShipment(minimalShipment({ status: 'draft' }));
      await markShipmentQuoted(created.id);
      expect((await findShipmentById(created.id))?.status).toBe('quoted');
    });

    /**
     * The case the predicate exists for.
     *
     * A provider adapter returning after the customer has already booked must
     * not walk the shipment back to `quoted`. Nothing reads the row count, so
     * this assertion is the only thing standing between the guard and a
     * plausible-looking simplification.
     */
    it('leaves a BOOKED shipment alone — the predicate is the whole statement', async () => {
      const created = await insertShipment(minimalShipment({ status: 'quoting' }));
      await markShipmentBooked(created.id, { jobId: 'job-x', quoteRef: 'quote-x' });

      await markShipmentQuoted(created.id);

      const read = await findShipmentById(created.id);
      expect(read?.status).toBe('booked');
      expect(read?.jobId).toBe('job-x');
      expect(read?.quoteRef).toBe('quote-x');
    });

    it('leaves a CANCELLED shipment alone', async () => {
      const created = await insertShipment(minimalShipment({ status: 'quoting' }));
      await markShipmentCancelled(created.id);

      await markShipmentQuoted(created.id);

      expect((await findShipmentById(created.id))?.status).toBe('cancelled');
    });
  });

  describe('listing and counting', () => {
    /**
     * The total is a NUMBER — and the case below it is what makes this
     * assertion mean anything.
     *
     * Stated honestly, because mutation-testing measured it: removing the
     * `Number(...)` from `countShipmentsForSender` leaves this test GREEN, since
     * drizzle's `count()` helper maps its own result. So this is a REGRESSION
     * PIN on the repository's spelling, not evidence that a decoding trap was
     * caught — and a test whose failure mode nobody has established is exactly
     * the kind that gets read as proof of something it never checked.
     */
    it('returns the total as a number', async () => {
      await insertShipment(minimalShipment({ senderOxyUserId: 'counter' }));
      await insertShipment(minimalShipment({ senderOxyUserId: 'counter' }));

      const total = await countShipmentsForSender({ senderOxyUserId: 'counter' });

      expect(typeof total).toBe('number');
      expect(total).toBe(2);
      // Arithmetic, because `"2" + 1` is `"21"` and `2 + 1` is `3` — the shape
      // the bigint trap actually takes when it reaches a caller.
      expect(total + 1).toBe(3);
    });

    /**
     * The raw spelling really does decode as a string — which is WHY the
     * repository uses drizzle's `count()` helper rather than a `sql` template.
     *
     * This is the discriminating half of the pair. Without it, the assertion
     * above pins a behaviour whose alternative nobody has demonstrated, and the
     * module comment claiming `int8` arrives as a string would be folklore
     * rather than a measurement. If a future driver or drizzle release maps this
     * too, this test goes red and the comment gets revisited — which is the
     * correct outcome, not a nuisance.
     */
    it('decodes a RAW count(*) as a string, which is the trap the helper avoids', async () => {
      await insertShipment(minimalShipment({ senderOxyUserId: 'raw-count' }));

      const [row] = await client()<Array<{ total: string }>>`
        SELECT count(*) AS total FROM shipments WHERE sender_oxy_user_id = 'raw-count'
      `;

      expect(typeof row?.total).toBe('string');
      expect(row?.total).toBe('1');
      // The shape the trap actually takes when it reaches a caller.
      expect((row?.total as unknown as number) + 1).toBe('11');
    });

    it('counts and lists only the sender´s own shipments', async () => {
      await insertShipment(minimalShipment({ senderOxyUserId: 'mine' }));
      await insertShipment(minimalShipment({ senderOxyUserId: 'theirs' }));

      expect(await countShipmentsForSender({ senderOxyUserId: 'mine' })).toBe(1);
      const rows = await listShipmentsForSender({ senderOxyUserId: 'mine' }, { page: 1, limit: 10 });
      expect(rows.map((r) => r.senderOxyUserId)).toEqual(['mine']);
    });

    it('filters by status and type independently', async () => {
      await insertShipment(minimalShipment({ senderOxyUserId: 'f', type: 'food', status: 'draft' }));
      await insertShipment(
        minimalShipment({ senderOxyUserId: 'f', type: 'package', status: 'quoting' }),
      );

      expect(await countShipmentsForSender({ senderOxyUserId: 'f', status: 'draft' })).toBe(1);
      expect(await countShipmentsForSender({ senderOxyUserId: 'f', type: 'package' })).toBe(1);
      expect(
        await countShipmentsForSender({ senderOxyUserId: 'f', status: 'draft', type: 'package' }),
      ).toBe(0);
    });

    /**
     * Newest first, and the timestamps are EXPLICIT.
     *
     * The ids are uuid v7, which is NOT monotonic within a millisecond — three
     * rows inserted in a tight loop would order arbitrarily on the id
     * tiebreaker, so a test that relied on insertion order would pass or fail on
     * the generator's luck rather than on the ORDER BY. Writing the timestamps
     * makes the assertion about `created_at DESC` and nothing else.
     */
    it('orders newest first by an explicitly written createdAt', async () => {
      const stamps = [
        ['oldest', '2026-01-01T00:00:00.000Z'],
        ['middle', '2026-02-01T00:00:00.000Z'],
        ['newest', '2026-03-01T00:00:00.000Z'],
      ] as const;
      // Inserted in an order that is neither the expected order nor its reverse.
      for (const [tag] of [stamps[1], stamps[2], stamps[0]]) {
        const created = await insertShipment(
          minimalShipment({ senderOxyUserId: 'ordered', itemDescription: tag }),
        );
        const at = stamps.find(([t]) => t === tag)?.[1];
        await client()`UPDATE shipments SET created_at = ${at} WHERE id = ${created.id}`;
      }

      const rows = await listShipmentsForSender(
        { senderOxyUserId: 'ordered' },
        { page: 1, limit: 10 },
      );
      expect(rows.map((r) => r.itemDescription)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('pages by offset without repeating or skipping a row', async () => {
      for (let i = 0; i < 5; i += 1) {
        const created = await insertShipment(
          minimalShipment({ senderOxyUserId: 'paged', itemDescription: `item-${i}` }),
        );
        await client()`
          UPDATE shipments SET created_at = ${`2026-01-0${i + 1}T00:00:00.000Z`} WHERE id = ${created.id}
        `;
      }

      const first = await listShipmentsForSender({ senderOxyUserId: 'paged' }, { page: 1, limit: 2 });
      const second = await listShipmentsForSender({ senderOxyUserId: 'paged' }, { page: 2, limit: 2 });
      const third = await listShipmentsForSender({ senderOxyUserId: 'paged' }, { page: 3, limit: 2 });

      const seen = [...first, ...second, ...third].map((r) => r.itemDescription);
      expect(seen).toEqual(['item-4', 'item-3', 'item-2', 'item-1', 'item-0']);
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('quotes', () => {
    it('round-trips a breakdown, rebuilding the audit pair on every component', async () => {
      const shipment = await insertShipment(minimalShipment());
      const [written] = await insertQuotes([
        {
          shipmentId: shipment.id,
          source: 'moovo_courier',
          priceBreakdown: breakdown(500),
          expiresAt: new Date(Date.now() + 60_000),
          status: 'active',
        },
      ]);

      const read = await findQuoteById(written!.id);
      expect(read?.priceBreakdown).toEqual(breakdown(500));
      expect(read?.currency).toBe('FAIR');
      expect(read?.source).toBe('moovo_courier');
    });

    it('stores the optional surge and fees components, and omits them when absent', async () => {
      const shipment = await insertShipment(minimalShipment());
      const withExtras: PriceBreakdown = {
        ...breakdown(700),
        surge: { fairMinor: 80, originalCurrency: 'FAIR' },
        fees: { fairMinor: 20, originalCurrency: 'FAIR' },
      };
      const [a, b] = await insertQuotes([
        {
          shipmentId: shipment.id,
          source: 'moovo_courier',
          priceBreakdown: withExtras,
          expiresAt: new Date(Date.now() + 60_000),
          status: 'active',
        },
        {
          shipmentId: shipment.id,
          source: 'external_provider',
          priceBreakdown: breakdown(600),
          expiresAt: new Date(Date.now() + 60_000),
          status: 'active',
        },
      ]);

      expect((await findQuoteById(a!.id))?.priceBreakdown).toEqual(withExtras);
      const plain = await findQuoteById(b!.id);
      expect(plain?.priceBreakdown).not.toHaveProperty('surge');
      expect(plain?.priceBreakdown).not.toHaveProperty('fees');
    });

    /**
     * The guard refuses BEFORE any SQL is issued.
     *
     * A guard that threw after a partial write would leave exactly the
     * falsified rows it exists to prevent, so the assertion is that the table
     * is untouched — not merely that the call rejected.
     */
    it('writes nothing at all when one quote in a batch has a divergent audit trail', async () => {
      const shipment = await insertShipment(minimalShipment());
      const divergent: PriceBreakdown = {
        ...breakdown(400),
        distance: { fairMinor: 250, originalCurrency: 'EUR' },
      };

      await expect(
        insertQuotes([
          {
            shipmentId: shipment.id,
            source: 'moovo_courier',
            priceBreakdown: breakdown(500),
            expiresAt: new Date(Date.now() + 60_000),
            status: 'active',
          },
          {
            shipmentId: shipment.id,
            source: 'external_provider',
            priceBreakdown: divergent,
            expiresAt: new Date(Date.now() + 60_000),
            status: 'active',
          },
        ]),
      ).rejects.toThrow(/disagree on originalCurrency/);

      expect(await listActiveQuotesForShipment(shipment.id)).toEqual([]);
    });

    it('lists active and selected quotes, excluding expired ones, ordered by source', async () => {
      const shipment = await insertShipment(minimalShipment());
      const expiresAt = new Date(Date.now() + 60_000);
      const [internal, external, lapsed] = await insertQuotes([
        {
          shipmentId: shipment.id,
          source: 'moovo_courier',
          priceBreakdown: breakdown(500),
          expiresAt,
          status: 'active',
        },
        {
          shipmentId: shipment.id,
          source: 'external_provider',
          priceBreakdown: breakdown(600),
          expiresAt,
          status: 'active',
        },
        {
          shipmentId: shipment.id,
          source: 'external_provider',
          priceBreakdown: breakdown(700),
          expiresAt,
          status: 'expired',
        },
      ]);

      await markQuoteSelected(internal!.id);
      const listed = await listActiveQuotesForShipment(shipment.id);

      // `external_provider` sorts before `moovo_courier` — the source's
      // `{source: 1}`, preserved verbatim because it is the order the API has
      // always returned.
      expect(listed.map((q) => q.id)).toEqual([external!.id, internal!.id]);
      expect(listed.map((q) => q.id)).not.toContain(lapsed!.id);
      // A selected quote is still listed: the customer must see what they chose.
      expect(listed.find((q) => q.id === internal!.id)?.status).toBe('selected');
    });

    it('cascades quotes when their shipment is deleted', async () => {
      const shipment = await insertShipment(minimalShipment());
      await insertQuotes([
        {
          shipmentId: shipment.id,
          source: 'moovo_courier',
          priceBreakdown: breakdown(500),
          expiresAt: new Date(Date.now() + 60_000),
          status: 'active',
        },
      ]);

      await client()`DELETE FROM shipments WHERE id = ${shipment.id}`;
      const [{ count }] = await client()<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM quotes WHERE shipment_id = ${shipment.id}
      `;
      expect(Number(count)).toBe(0);
    });
  });

  /**
   * The quotes and the status flip commit together.
   *
   * This is the property the port ADDS — the source wrote the two collections
   * separately, so a crash between them left a shipment stuck in `quoting` with
   * its quotes already visible. It rests entirely on both repository functions
   * using the handle they are PASSED: one that reached for `getDb()` itself
   * would open a second connection, commit outside the caller's block and
   * type-check perfectly.
   */
  describe('the write half is atomic', () => {
    it('rolls back the quotes AND the status flip together', async () => {
      const shipment = await insertShipment(minimalShipment({ status: 'quoting' }));

      await expect(
        database().transaction(async (tx) => {
          await insertQuotes(
            [
              {
                shipmentId: shipment.id,
                source: 'moovo_courier',
                priceBreakdown: breakdown(500),
                expiresAt: new Date(Date.now() + 60_000),
                status: 'active',
              },
            ],
            tx,
          );
          await markShipmentQuoted(shipment.id, tx);
          throw new Error('the write half failed after both statements');
        }),
      ).rejects.toThrow('the write half failed after both statements');

      expect(await listActiveQuotesForShipment(shipment.id)).toEqual([]);
      expect((await findShipmentById(shipment.id))?.status).toBe('quoting');
    });

    it('commits both when the block succeeds', async () => {
      const shipment = await insertShipment(minimalShipment({ status: 'quoting' }));

      await database().transaction(async (tx) => {
        await insertQuotes(
          [
            {
              shipmentId: shipment.id,
              source: 'moovo_courier',
              priceBreakdown: breakdown(500),
              expiresAt: new Date(Date.now() + 60_000),
              status: 'active',
            },
          ],
          tx,
        );
        await markShipmentQuoted(shipment.id, tx);
      });

      expect(await listActiveQuotesForShipment(shipment.id)).toHaveLength(1);
      expect((await findShipmentById(shipment.id))?.status).toBe('quoted');
    });
  });

  /**
   * The moderation projection withholds by NOT FETCHING.
   *
   * `delivery-context.ts` assembles material a stranger on a jury will read. Its
   * argument is that a contact name, a phone number, two street addresses and
   * the photo file ids are never loaded — which is a claim about the SELECT
   * list, so it can only be tested here. The key set is asserted EXACTLY, so a
   * column added to the projection later fails this test rather than quietly
   * travelling.
   */
  it('projects only the moderation facts, with the photo count and no photo ids', async () => {
    const created = await insertShipment(fullShipment());
    await updateShipmentDistance(created.id, 12_400);

    const facts = await findShipmentModerationFacts(created.id);

    expect(Object.keys(facts ?? {}).sort()).toEqual([
      'distanceM',
      'id',
      'itemDescription',
      'photoCount',
      'type',
    ]);
    expect(facts?.photoCount).toBe(2);
    expect(typeof facts?.photoCount).toBe('number');
    expect(facts?.distanceM).toBe(12_400);

    // The values that must never travel are absent from the object entirely,
    // which is a stronger statement than a redactor declining to pass them on.
    const serialised = JSON.stringify(facts);
    for (const secret of ['Anna Puig', '+34600111222', 'Carrer de Mallorca', 'file-a', '08013']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('returns null moderation facts for a shipment that no longer exists', async () => {
    const created = await insertShipment(minimalShipment());
    await client()`DELETE FROM shipments WHERE id = ${created.id}`;
    expect(await findShipmentModerationFacts(created.id)).toBeNull();
  });

  /**
   * The scheduling CHECK is real, and the mapper does not route around it.
   *
   * `shipments_scheduling_shape_check` states the source's `pre('validate')`
   * hook: a `scheduled` shipment carries a time and a `now` shipment does not.
   * The mapper nulls `scheduled_for` for a `now` shipment, so the only way to
   * reach the constraint is to write the contradiction directly — which is what
   * proves the constraint is enforcing rather than merely present.
   */
  it('refuses a scheduled shipment with no time, and a now shipment with one', async () => {
    const created = await insertShipment(minimalShipment());

    await expect(
      client()`UPDATE shipments SET scheduling_kind = 'scheduled', scheduled_for = NULL WHERE id = ${created.id}`,
    ).rejects.toThrow(/shipments_scheduling_shape_check/);

    await expect(
      client()`UPDATE shipments SET scheduling_kind = 'now', scheduled_for = now() WHERE id = ${created.id}`,
    ).rejects.toThrow(/shipments_scheduling_shape_check/);
  });

  /**
   * A shipment ALWAYS has both positions, so the generated point is never null.
   *
   * `generatedGeographyPoint` is documented as STRICT — a null ordinate yields a
   * null point rather than a position in the Gulf of Guinea — and on `shipments`
   * that branch is UNREACHABLE, because all four ordinate columns are NOT NULL.
   * Pinned rather than left implicit: the strictness is a property of the helper
   * and the non-nullability is a property of this table, and a future migration
   * relaxing the latter would silently make a shipment with half a route
   * representable. `job_status_events` and `courier_profiles` are where the
   * nullable case actually lives, and `geo.realdb.test.ts` covers it there.
   */
  it('cannot store a shipment with a missing ordinate, so its point is never null', async () => {
    const created = await insertShipment(minimalShipment());

    await expect(
      client()`UPDATE shipments SET pickup_latitude = NULL WHERE id = ${created.id}`,
    ).rejects.toThrow(/not-null constraint/);

    const [row] = await client()<Array<{ present: boolean }>>`
      SELECT pickup_location IS NOT NULL AS present FROM shipments WHERE id = ${created.id}
    `;
    expect(row?.present).toBe(true);
  });

  /**
   * BOTH endpoints are validated, and each side needs its own case.
   *
   * Measured rather than assumed, because the obvious justification for this
   * turned out to be wrong and the accurate one is narrower. Lint (not a test)
   * flagged the dropoff half computing its validated pair and then discarding
   * it, reading the raw array instead. That looked like a live bug and is not
   * one: `ordinates()` still RAN, and the two ordinates it returns are the same
   * two the raw reads take, so the mutation is behaviour-preserving and this
   * suite stays green against it — confirmed by reintroducing it.
   *
   * What these cases DO catch is the validation being absent altogether:
   * replacing the `ordinates(input.dropoff, 'dropoff')` call with a plain read
   * fails exactly the dropoff case and nothing else. That is the property worth
   * pinning — a guard on a symmetric pair needs a case per side, or one side
   * can lose its guard while every test still passes.
   */
  it.each([
    ['pickup', (s: NewShipment) => { s.pickup.location.coordinates = [2.1734]; }],
    ['dropoff', (s: NewShipment) => { s.dropoff.location.coordinates = [2.8249]; }],
    ['pickup NaN', (s: NewShipment) => { s.pickup.location.coordinates = [Number.NaN, 41.4]; }],
  ])('refuses a malformed %s coordinate pair before it reaches the server', async (label, break_) => {
    const broken = minimalShipment();
    break_(broken);

    const endpoint = label.startsWith('pickup') ? 'pickup' : 'dropoff';
    await expect(insertShipment(broken)).rejects.toThrow(
      new RegExp(`${endpoint} location needs a finite`),
    );
    // Nothing was written, so the refusal cost nothing to recover from.
    expect(await countShipmentsForSender({ senderOxyUserId: broken.senderOxyUserId })).toBe(0);
  });

  it('counts zero for a sender with no shipments at all', async () => {
    // A vacuity floor for the filter tests above: the predicate really does
    // discriminate, rather than every count happening to be non-zero.
    expect(await countShipmentsForSender({ senderOxyUserId: 'nobody' })).toBe(0);
    expect(
      await listShipmentsForSender({ senderOxyUserId: 'nobody' }, { page: 1, limit: 10 }),
    ).toEqual([]);
  });

});

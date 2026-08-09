/**
 * The geography columns, measured rather than inspected.
 *
 * Courier dispatch is the core of the product and it is a geo query: `$nearSphere`
 * around a job's pickup, `.limit(waveSize)`, nearest first. Two things about
 * that fail SILENTLY if the port is wrong, and neither shows up as an error:
 *
 *  - **Ordinate order.** GeoJSON stores `[lng, lat]` and `ST_MakePoint` takes
 *    `(lng, lat)`. Swap them and every position is still a valid point, every
 *    query still returns rows, and every courier is in the wrong hemisphere.
 *    Only a REAL DISTANCE against a known landmark catches it — which is why
 *    this file uses cities whose separation is public knowledge rather than
 *    synthetic points a swapped implementation would also satisfy.
 *  - **Ordering.** A query that returns the right rows in the wrong order still
 *    returns rows. With `LIMIT`, wrong order means the wrong couriers are
 *    offered the job — the query "works" and the product is broken.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/** Real places, so a real distance can be asserted. `[lng, lat]`, GeoJSON order. */
const MADRID: readonly [number, number] = [-3.7038, 40.4168];
const BARCELONA: readonly [number, number] = [2.1734, 41.3851];
const LISBON: readonly [number, number] = [-9.1393, 38.7223];

/** Madrid→Barcelona is ~505 km and Madrid→Lisbon ~502 km by great circle. */
const MADRID_BARCELONA_M = 505_000;
const MADRID_LISBON_M = 502_000;
const TOLERANCE_M = 15_000;

describeIfPostgres('geography columns', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    // Three couriers, seeded in an order that is NEITHER the distance order nor
    // its reverse, so a query that ignores ordering entirely cannot pass by
    // accident of insertion order.
    for (const [oxyUserId, [lng, lat]] of [
      ['courier-barcelona', BARCELONA],
      ['courier-madrid', MADRID],
      ['courier-lisbon', LISBON],
    ] as const) {
      await suite.client`
        INSERT INTO courier_profiles (id, oxy_user_id, latitude, longitude)
        VALUES (${oxyUserId}, ${oxyUserId}, ${lat}, ${lng})
      `;
    }
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('stores [lng, lat] in the order PostGIS reads it, proven by a real distance', async () => {
    // The assertion that catches a swap. Madrid and Barcelona are ~505 km
    // apart; with latitude and longitude transposed the same two rows come out
    // roughly 1,000 km apart, so the tolerance below cannot absorb the error.
    const [row] = await suite!.client<{ meters: number }[]>`
      SELECT ST_Distance(
        (SELECT location FROM courier_profiles WHERE oxy_user_id = 'courier-madrid'),
        (SELECT location FROM courier_profiles WHERE oxy_user_id = 'courier-barcelona')
      ) AS meters
    `;
    expect(row?.meters).toBeGreaterThan(MADRID_BARCELONA_M - TOLERANCE_M);
    expect(row?.meters).toBeLessThan(MADRID_BARCELONA_M + TOLERANCE_M);
  });

  it('reads a generated point back as a Point at SRID 4326', async () => {
    const [row] = await suite!.client<{ type: string; srid: number }[]>`
      SELECT ST_GeometryType(location::geometry) AS type, ST_SRID(location) AS srid
      FROM courier_profiles WHERE oxy_user_id = 'courier-madrid'
    `;
    // The column is declared bare because drizzle-kit cannot emit the
    // `(Point,4326)` typmod; that the stored value really is a Point at 4326
    // is therefore asserted here, against a real row, instead.
    expect(row?.type).toBe('ST_Point');
    expect(row?.srid).toBe(4326);
  });

  it('orders couriers nearest-first — the property dispatch LIMITs against', async () => {
    // This is `dispatch.service.ts`'s query shape: a radius filter plus
    // distance ordering, then a limit. `search.service.ts` is deliberately
    // NOT this shape — see the note at the end of this file.
    const rows = await suite!.client<{ oxy_user_id: string; meters: number }[]>`
      SELECT oxy_user_id,
             ST_Distance(location, ST_SetSRID(ST_MakePoint(${MADRID[0]}, ${MADRID[1]}), 4326)::geography) AS meters
      FROM courier_profiles
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${MADRID[0]}, ${MADRID[1]}), 4326)::geography, 600000)
      ORDER BY location <-> ST_SetSRID(ST_MakePoint(${MADRID[0]}, ${MADRID[1]}), 4326)::geography
    `;

    expect(rows.map((row) => row.oxy_user_id)).toEqual([
      'courier-madrid',
      'courier-lisbon',
      'courier-barcelona',
    ]);

    // Lisbon before Barcelona is a THREE-kilometre difference over ~500 km.
    // Asserted explicitly because it is what makes the ordering claim real: an
    // implementation that sorted by anything coarser — by name, by insertion,
    // by a rounded distance — would satisfy a two-city test and fail this one.
    expect(rows[1]?.meters).toBeLessThan(rows[2]?.meters ?? 0);
    expect(rows[1]?.meters).toBeGreaterThan(MADRID_LISBON_M - TOLERANCE_M);
  });

  it('excludes couriers outside the radius rather than merely ranking them last', async () => {
    const rows = await suite!.client<{ oxy_user_id: string }[]>`
      SELECT oxy_user_id FROM courier_profiles
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${MADRID[0]}, ${MADRID[1]}), 4326)::geography, 100000)
    `;
    expect(rows.map((row) => row.oxy_user_id)).toEqual(['courier-madrid']);
  });

  it('leaves a courier who has never reported a position out of every geo query', async () => {
    // `courier-profile.ts` goes out of its way to never persist an empty Point,
    // because an absent position and a position at (0, 0) — in the Gulf of
    // Guinea, ~4,000 km from Madrid — are different facts. A NULL ordinate
    // generates a NULL location, so the row is simply not a candidate.
    await suite!.client`
      INSERT INTO courier_profiles (id, oxy_user_id) VALUES ('courier-silent', 'courier-silent')
    `;
    const [row] = await suite!.client<{ location: string | null }[]>`
      SELECT location FROM courier_profiles WHERE oxy_user_id = 'courier-silent'
    `;
    expect(row?.location).toBeNull();

    const rows = await suite!.client<{ oxy_user_id: string }[]>`
      SELECT oxy_user_id FROM courier_profiles
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 50000)
    `;
    expect(rows).toEqual([]);
  });

  it('refuses a half-reported position', async () => {
    // The one geo shape Mongo really did allow, on `listings.location`.
    await expect(
      suite!.client`
        INSERT INTO courier_profiles (id, oxy_user_id, latitude)
        VALUES ('courier-partial', 'courier-partial', 40.4168)
      `,
    ).rejects.toThrow(/courier_profiles_location_shape_check/);
  });

  it('matches search.service.ts: a radius FILTER, with the declared sort winning', async () => {
    // Measured against a real mongod (8.2.6), because it is not answerable from
    // source: `search.service.ts` chains `.sort(buildSort(...))` after a `$near`
    // filter, and `buildSort` never special-cases the geo case. An explicit
    // sort OVERRIDES `$near`'s distance ordering — ANY explicit sort, verified
    // with `_id` as a control — and no error is raised.
    //
    // So Moovo's live "near me" behaviour is: filter to the radius, then order
    // by the declared sort. This test pins the port to THAT, not to distance
    // ordering. Making search distance-ordered would be a better product and is
    // a separate change with its own before/after — landing it inside a
    // migration would make any post-cutover complaint impossible to attribute
    // to a port defect rather than an intended behaviour change.
    const rows = await suite!.client<{ oxy_user_id: string }[]>`
      SELECT oxy_user_id FROM courier_profiles
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${MADRID[0]}, ${MADRID[1]}), 4326)::geography, 600000)
      ORDER BY oxy_user_id ASC
    `;
    // Alphabetical, NOT nearest-first — the declared sort wins, exactly as the
    // driver does. Nearest-first would be madrid, lisbon, barcelona.
    expect(rows.map((row) => row.oxy_user_id)).toEqual([
      'courier-barcelona',
      'courier-lisbon',
      'courier-madrid',
    ]);
  });
});

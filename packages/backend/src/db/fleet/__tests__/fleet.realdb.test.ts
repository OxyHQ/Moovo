/**
 * The fleet domain against a real PostgreSQL + PostGIS server.
 *
 * Four properties here exist nowhere else, and each is invisible to a mock:
 *
 *  - **The enforcement levers' BOOLEAN.** `suspendCourier`/`reinstateCourier`
 *    are the only place in Moovo that consumes a row count, and their answer is
 *    written into the moderation audit trail as "applied" or "not applied". A
 *    lever that always reported success would record a suspension that never
 *    happened. The discriminator is a REPEATED call — one call returns the same
 *    answer under either semantics — so every case below runs the lever twice.
 *  - **Dispatch ordering.** `findDispatchCandidates` must return NEAREST FIRST,
 *    because `dispatch.service` takes the first `waveSize` of them and offers
 *    the job to exactly those couriers. A query returning the right couriers in
 *    the wrong order is not an error, it is worse delivery times forever.
 *  - **The partial GiST index's predicate**, i.e. that a courier who has never
 *    pinged is excluded rather than treated as being at (0, 0).
 *  - **A company and its owner committing together**, which the source got for
 *    free by embedding `members` in the same document.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import {
  ensureCourierProfile,
  findCourierProfile,
  findDispatchCandidates,
  recordCourierPing,
  reinstateCourier,
  setCourierOnlineStatus,
  suspendCourier,
  updateCourierCapability,
} from '../courierProfileRepository';
import {
  companyHandleExists,
  findCompanyById,
  insertCompanyWithOwner,
  upsertCompanyMember,
} from '../courierCompanyRepository';
import { insertVehicle, listVehiclesForCourier } from '../vehicleRepository';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/**
 * The constraint a rejected write actually names.
 *
 * drizzle wraps a driver error as `Failed query: …`, so the constraint name is
 * NOT in `error.message` — it is on the postgres.js error underneath. Asserting
 * the wrapper's message would pass for ANY failed insert, including a typo in
 * the column list, which is precisely the check-that-cannot-fail shape.
 */
function violatedConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint_name?: string } }).cause;
  return cause?.constraint_name;
}

/** Run a write expected to be refused, and return the constraint that refused it. */
async function refusedBy(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
  } catch (error: unknown) {
    return violatedConstraint(error);
  }
  return undefined;
}

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** Barcelona, and two points at increasing distance from it. `[lng, lat]`. */
const PICKUP = { longitude: 2.1734, latitude: 41.3851 };
const NEAR = { longitude: 2.18, latitude: 41.39 };
const MID = { longitude: 2.25, latitude: 41.42 };
const FAR = { longitude: 2.32, latitude: 41.45 };

/** Put a courier online, capable, freshly pinged, at a position. */
async function seedCourier(
  oxyUserId: string,
  at: { longitude: number; latitude: number },
): Promise<void> {
  await ensureCourierProfile(oxyUserId);
  await updateCourierCapability(oxyUserId, {
    eligibleJobTypes: ['package'],
    maxWeightKg: 50,
    maxSizeClass: 'large',
  });
  await setCourierOnlineStatus(oxyUserId, 'online');
  await recordCourierPing(oxyUserId, at);
}

function dispatchQuery(overrides: Record<string, unknown> = {}) {
  return {
    pickup: PICKUP,
    radiusM: 20_000,
    jobType: 'package',
    weightKg: 3,
    stalePingCutoff: new Date(Date.now() - 60_000),
    excludeOxyUserIds: [] as string[],
    limit: 10,
    ...overrides,
  };
}

describeIfPostgres('the fleet domain on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    await client()`DELETE FROM courier_profiles`;
    await client()`DELETE FROM vehicles`;
    await client()`DELETE FROM courier_companies`;
  });

  describe('the moderation enforcement levers', () => {
    it('suspends once and reports NOT APPLIED on the repeat', async () => {
      await ensureCourierProfile('c-suspend');

      // The discriminator. A single call cannot tell a faithful port from one
      // that always reports success.
      expect(await suspendCourier('c-suspend')).toBe(true);
      expect(await suspendCourier('c-suspend')).toBe(false);

      expect((await findCourierProfile('c-suspend'))?.status).toBe('suspended');
    });

    it('reinstates once and reports NOT APPLIED on the repeat', async () => {
      await ensureCourierProfile('c-reinstate');
      await suspendCourier('c-reinstate');

      expect(await reinstateCourier('c-reinstate')).toBe(true);
      expect(await reinstateCourier('c-reinstate')).toBe(false);

      expect((await findCourierProfile('c-reinstate'))?.status).toBe('active');
    });

    it('reports NOT APPLIED for a courier with no profile at all', async () => {
      // A real outcome the source deliberately reports rather than treating as
      // success: a customer reported under the `courier` type, or a deleted
      // profile.
      expect(await suspendCourier('c-nobody')).toBe(false);
      expect(await reinstateCourier('c-nobody')).toBe(false);
    });

    it('refuses to reinstate a PENDING courier, who was never suspended by us', async () => {
      await ensureCourierProfile('c-pending');
      expect((await findCourierProfile('c-pending'))?.status).toBe('pending');

      expect(await reinstateCourier('c-pending')).toBe(false);
      // Onboarding state is not ours to skip.
      expect((await findCourierProfile('c-pending'))?.status).toBe('pending');
    });

    it('drops the courier offline on suspension and does NOT restore it on reinstate', async () => {
      await seedCourier('c-online', NEAR);
      expect((await findCourierProfile('c-online'))?.onlineStatus).toBe('online');

      await suspendCourier('c-online');
      expect((await findCourierProfile('c-online'))?.onlineStatus).toBe('offline');

      await reinstateCourier('c-online');
      // Availability is the courier's to set — an appeal does not put somebody
      // back on shift.
      expect((await findCourierProfile('c-online'))?.onlineStatus).toBe('offline');
    });
  });

  describe('dispatch candidate selection', () => {
    it('returns candidates NEAREST FIRST', async () => {
      // Seeded in an order that is neither the expected order nor its reverse,
      // so a query that ignores ordering cannot pass by accident of insertion.
      await seedCourier('c-mid', MID);
      await seedCourier('c-far', FAR);
      await seedCourier('c-near', NEAR);

      const candidates = await findDispatchCandidates(dispatchQuery());

      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-near', 'c-mid', 'c-far']);
    });

    it('takes the NEAREST when the wave is smaller than the candidate set', async () => {
      await seedCourier('c-mid', MID);
      await seedCourier('c-far', FAR);
      await seedCourier('c-near', NEAR);

      // This is what the ordering is FOR: `dispatch.service` limits to the wave
      // size, so the order decides who is offered the job at all.
      const candidates = await findDispatchCandidates(dispatchQuery({ limit: 2 }));
      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-near', 'c-mid']);
    });

    it('excludes a courier who has never pinged rather than placing them at (0,0)', async () => {
      await ensureCourierProfile('c-never-pinged');
      await updateCourierCapability('c-never-pinged', {
        eligibleJobTypes: ['package'],
        maxWeightKg: 50,
        maxSizeClass: 'large',
      });
      await setCourierOnlineStatus('c-never-pinged', 'online');
      await seedCourier('c-near', NEAR);

      const candidates = await findDispatchCandidates(dispatchQuery());
      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-near']);
    });

    it('excludes couriers outside the radius, offline, stale, or under-capacity', async () => {
      await seedCourier('c-near', NEAR);

      // Outside the radius.
      await seedCourier('c-distant', { longitude: 3.5, latitude: 42.5 });
      // Offline.
      await seedCourier('c-offline', NEAR);
      await setCourierOnlineStatus('c-offline', 'offline');
      // Stale ping.
      await seedCourier('c-stale', NEAR);
      await client()`
        UPDATE courier_profiles SET last_ping_at = now() - interval '1 day'
        WHERE oxy_user_id = 'c-stale'
      `;
      // Cannot carry the load.
      await seedCourier('c-light', NEAR);
      await updateCourierCapability('c-light', {
        eligibleJobTypes: ['package'],
        maxWeightKg: 1,
        maxSizeClass: 'small',
      });

      const candidates = await findDispatchCandidates(dispatchQuery());
      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-near']);
    });

    it('matches the job type by ARRAY CONTAINMENT, not equality', async () => {
      // `eq()` on a text[] column compiles, runs, and matches nothing — dispatch
      // would find no couriers and read as "nobody is online".
      await seedCourier('c-multi', NEAR);
      await updateCourierCapability('c-multi', {
        eligibleJobTypes: ['food', 'package', 'move'],
        maxWeightKg: 50,
        maxSizeClass: 'large',
      });

      const candidates = await findDispatchCandidates(dispatchQuery());
      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-multi']);
    });

    it('honours the exclude list', async () => {
      await seedCourier('c-near', NEAR);
      await seedCourier('c-mid', MID);

      const candidates = await findDispatchCandidates(
        dispatchQuery({ excludeOxyUserIds: ['c-near'] }),
      );
      expect(candidates.map((c) => c.oxyUserId)).toEqual(['c-mid']);
    });
  });

  describe('the courier profile lifecycle', () => {
    it('creates lazily and converges on ONE row under a repeat', async () => {
      const first = await ensureCourierProfile('c-lazy');
      const second = await ensureCourierProfile('c-lazy');

      expect(second.id).toBe(first.id);
      const [{ count }] = await client()<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM courier_profiles WHERE oxy_user_id = 'c-lazy'
      `;
      expect(Number(count)).toBe(1);
    });

    it('does not touch updated_at when a get-or-create finds an existing row', async () => {
      const created = await ensureCourierProfile('c-untouched');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const read = await ensureCourierProfile('c-untouched');

      // A `DO UPDATE` writing the key back to itself would bump this, making a
      // getter a writer — see the repository's own note.
      expect(read.updatedAt.getTime()).toBe(created.updatedAt.getTime());
    });

    it('clears the active vehicle pointer when that vehicle is deleted', async () => {
      const vehicle = await insertVehicle({
        ownerType: 'courier',
        courierOxyUserId: 'c-veh',
        type: 'bike',
        capacity: { maxWeightKg: 20 },
        eligibleJobTypes: ['package'],
      });
      await ensureCourierProfile('c-veh');
      await updateCourierCapability('c-veh', {
        activeVehicleId: vehicle.id,
        eligibleJobTypes: ['package'],
        maxWeightKg: 20,
        maxSizeClass: 'small',
      });

      await client()`DELETE FROM vehicles WHERE id = ${vehicle.id}`;

      // `ON DELETE SET NULL`, which is load-bearing rather than decorative
      // because `vehicle.service` really does hard-delete.
      expect((await findCourierProfile('c-veh'))?.activeVehicleId).toBeNull();
    });

    it('derives the courier vehicle list that replaced the dropped array', async () => {
      await insertVehicle({
        ownerType: 'courier',
        courierOxyUserId: 'c-owner',
        type: 'bike',
        capacity: { maxWeightKg: 20 },
        eligibleJobTypes: ['package'],
      });
      // A COMPANY vehicle the courier does not own must never appear.
      const company = await insertCompanyWithOwner(
        { handle: 'fleet-co', name: 'Fleet Co', description: '', brandColor: '#000' },
        { oxyUserId: 'c-owner', permissions: ['fleet:write'] },
      );
      await insertVehicle({
        ownerType: 'company',
        companyId: company.id,
        type: 'van',
        capacity: { maxWeightKg: 800 },
        eligibleJobTypes: ['move'],
      });

      const owned = await listVehiclesForCourier('c-owner');
      expect(owned).toHaveLength(1);
      expect(owned[0]?.type).toBe('bike');
    });
  });

  describe('companies and their members', () => {
    it('creates the company and its owner member together', async () => {
      const company = await insertCompanyWithOwner(
        { handle: 'acme', name: 'Acme', description: 'x', brandColor: '#123456' },
        { oxyUserId: 'owner-1', permissions: ['company:manage', 'members:manage'] },
      );

      const read = await findCompanyById(company.id);
      expect(read?.members).toHaveLength(1);
      expect(read?.members[0]).toMatchObject({ oxyUserId: 'owner-1', role: 'owner' });
      expect(await companyHandleExists('acme')).toBe(true);
    });

    /**
     * Re-adding an existing member converges on ONE row.
     *
     * The source pushed into an array with no uniqueness, so this produced a
     * second entry that shadowed the first depending on which the reader hit.
     */
    it('converges on one member row when the same person is added twice', async () => {
      const company = await insertCompanyWithOwner(
        { handle: 'dup', name: 'Dup', description: '', brandColor: '#000' },
        { oxyUserId: 'owner-1', permissions: [] },
      );

      await upsertCompanyMember(company.id, {
        oxyUserId: 'member-1',
        role: 'driver',
        permissions: ['jobs:read'],
      });
      await upsertCompanyMember(company.id, {
        oxyUserId: 'member-1',
        role: 'dispatcher',
        permissions: ['jobs:dispatch'],
      });

      const read = await findCompanyById(company.id);
      const member = read?.members.filter((m) => m.oxyUserId === 'member-1') ?? [];
      expect(member).toHaveLength(1);
      expect(member[0]?.role).toBe('dispatcher');
    });

    it('keeps the original joinedAt when a member is re-added', async () => {
      const company = await insertCompanyWithOwner(
        { handle: 'joined', name: 'Joined', description: '', brandColor: '#000' },
        { oxyUserId: 'owner-1', permissions: [] },
      );
      const first = await upsertCompanyMember(company.id, {
        oxyUserId: 'member-1',
        role: 'driver',
        permissions: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await upsertCompanyMember(company.id, {
        oxyUserId: 'member-1',
        role: 'dispatcher',
        permissions: [],
      });

      // Re-adding somebody must not rewrite when they originally joined.
      expect(second.joinedAt.getTime()).toBe(first.joinedAt.getTime());
    });

    it('cascades members when the company is deleted', async () => {
      const company = await insertCompanyWithOwner(
        { handle: 'gone', name: 'Gone', description: '', brandColor: '#000' },
        { oxyUserId: 'owner-1', permissions: [] },
      );
      await client()`DELETE FROM courier_companies WHERE id = ${company.id}`;

      const [{ count }] = await client()<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM company_members WHERE company_id = ${company.id}
      `;
      expect(Number(count)).toBe(0);
    });

    it('clears a courier´s company pointer rather than blocking the delete', async () => {
      const company = await insertCompanyWithOwner(
        { handle: 'affil', name: 'Affil', description: '', brandColor: '#000' },
        { oxyUserId: 'owner-1', permissions: [] },
      );
      await ensureCourierProfile('c-affiliated');
      await client()`
        UPDATE courier_profiles SET company_id = ${company.id} WHERE oxy_user_id = 'c-affiliated'
      `;

      await client()`DELETE FROM courier_companies WHERE id = ${company.id}`;

      // Deleting the company must not orphan or block the courier's own profile.
      const profile = await findCourierProfile('c-affiliated');
      expect(profile).not.toBeNull();
      expect(profile?.companyId).toBeNull();
    });
  });

  it('refuses a vehicle owned by both a courier and a company', async () => {
    // `vehicles_owner_shape_check` — the `pre('validate')` hook, as the database
    // states it. Not re-expressed in the repository, so this is the ONLY thing
    // enforcing it.
    const constraint = await refusedBy(() =>
      insertVehicle({
        ownerType: 'courier',
        courierOxyUserId: 'c-1',
        companyId: 'company-1',
        type: 'bike',
        capacity: { maxWeightKg: 20 },
        eligibleJobTypes: ['package'],
      }),
    );
    expect(constraint).toBe('vehicles_owner_shape_check');
  });

  it('refuses a vehicle owned by neither', async () => {
    const constraint = await refusedBy(() =>
      insertVehicle({
        ownerType: 'courier',
        type: 'bike',
        capacity: { maxWeightKg: 20 },
        eligibleJobTypes: ['package'],
      }),
    );
    expect(constraint).toBe('vehicles_owner_shape_check');
  });
});

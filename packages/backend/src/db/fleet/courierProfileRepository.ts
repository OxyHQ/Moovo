/**
 * Every statement this service issues against `courier_profiles`.
 *
 * Three things here are easy to get subtly wrong and silent when wrong.
 *
 * **1. `suspendCourier`/`reinstateCourier` CONSUME the row count, and almost
 * nothing else in this repo does.** Their boolean answer is written into the
 * moderation audit trail as "applied" or "not applied", so a port that always
 * reported success would record enforcement that never happened — and a jury's
 * decision would read as carried out. Mongo's `matchedCount` counts documents
 * matching the FILTER; Postgres `rowCount` counts rows the UPDATE wrote. Those
 * two disagree when a filter matches a row whose values are already the target
 * values — and here they CANNOT, because both predicates exclude the no-change
 * case themselves (`status <> 'suspended'`, `status = 'suspended'`). So the port
 * is faithful, and the discriminator is a REPEATED call: the second suspend must
 * answer "not applied". `fleet.realdb.test.ts` calls each twice.
 *
 * The count is read as `result.count`, measured against this driver rather than
 * assumed: a drizzle/postgres.js UPDATE result reports `count` 1 on a hit and 0
 * on a miss, while its `length` is **0 in BOTH cases**. So the obvious-looking
 * `rows.length > 0` is not a worse spelling — it is a guard that reports "not
 * applied" for every suspension that actually happened, with no error anywhere.
 *
 * **2. The upserts return the row, so `ON CONFLICT DO NOTHING` is not enough.**
 * The source's `findOneAndUpdate(..., {upsert: true, returnDocument: 'after'})`
 * always yields a document. `DO NOTHING` returns NO row on conflict, so a
 * get-or-create needs the insert's empty `RETURNING` followed by a SELECT —
 * never a `DO UPDATE` that writes the key back to itself, which would bump
 * `updated_at` on every read and make a getter a writer.
 *
 * **3. `vehicleIds` does not exist** (see the schema's own note). The array was
 * a cache of `select id from vehicles where owner_type='courier' and
 * courier_oxy_user_id = $1`, so the profile no longer tracks vehicles at all and
 * `trackVehicle` is gone. What that function ALSO did — create the profile if
 * the courier had none — is preserved explicitly by `ensureCourierProfile`,
 * because losing it would let a courier own a vehicle with no profile row.
 */

import { and, asc, eq, gte, inArray, isNotNull, not, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { courierProfiles } from '../schema/fleet';

/** A `courier_profiles` row exactly as stored. */
export type CourierProfileRow = typeof courierProfiles.$inferSelect;

/** The editable capability cache, recomputed from the active vehicle. */
export interface CourierCapabilityPatch {
  eligibleJobTypes: string[];
  maxWeightKg: number;
  maxSizeClass: string;
  activeVehicleId?: string | null;
}

/**
 * Get the courier's profile, creating an empty one on first use.
 *
 * Two statements rather than one, deliberately — see the module header. The
 * insert races safely: a concurrent first-write makes `DO NOTHING` return
 * nothing and the SELECT then reads the winner's row.
 */
export async function ensureCourierProfile(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  const [inserted] = await db
    .insert(courierProfiles)
    .values({ id: uuidv7(), oxyUserId })
    .onConflictDoNothing({ target: courierProfiles.oxyUserId })
    .returning();
  if (inserted) return inserted;

  const existing = await findCourierProfile(oxyUserId, db);
  if (!existing) {
    // The row was neither inserted nor found: the only way here is a delete
    // racing the insert, and answering with a fabricated profile would be worse.
    throw new Error(`Courier profile for ${oxyUserId} vanished during creation`);
  }
  return existing;
}

/** One courier's profile, or null. */
export async function findCourierProfile(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow | null> {
  const [row] = await db
    .select()
    .from(courierProfiles)
    .where(eq(courierProfiles.oxyUserId, oxyUserId))
    .limit(1);
  return row ?? null;
}

/** Profiles for a set of couriers, for a hydration batch. */
export async function findCourierProfilesByOxyUserIds(
  oxyUserIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow[]> {
  if (oxyUserIds.length === 0) return [];
  return await db
    .select()
    .from(courierProfiles)
    .where(inArray(courierProfiles.oxyUserId, [...oxyUserIds]));
}

/**
 * Upsert the profile, applying `patch`, and return it as it now stands.
 *
 * The single shape behind every `$setOnInsert` + `$set` + `returnDocument:
 * 'after'` call in `courier-profile.service`. An empty patch is a plain
 * get-or-create and is routed there rather than issuing a `DO UPDATE` that
 * writes nothing but still bumps `updated_at`.
 */
async function upsertCourierProfile(
  oxyUserId: string,
  patch: Partial<typeof courierProfiles.$inferInsert>,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  if (Object.keys(patch).length === 0) {
    return ensureCourierProfile(oxyUserId, db);
  }
  const [row] = await db
    .insert(courierProfiles)
    .values({ id: uuidv7(), oxyUserId, ...patch })
    .onConflictDoUpdate({ target: courierProfiles.oxyUserId, set: patch })
    .returning();
  if (!row) {
    throw new Error(`Upserting the courier profile for ${oxyUserId} returned no row`);
  }
  return row;
}

/** Set the courier's availability. Never flips `on_job` — that is job-driven. */
export async function setCourierOnlineStatus(
  oxyUserId: string,
  onlineStatus: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  return upsertCourierProfile(oxyUserId, { onlineStatus }, db);
}

/**
 * Record a location ping.
 *
 * Writes the two ORDINATES; `location` is `GENERATED ALWAYS` from them and
 * Postgres rejects an explicit write to it. That is what makes it impossible
 * for the point and the ordinates to disagree.
 */
export async function recordCourierPing(
  oxyUserId: string,
  { longitude, latitude }: { longitude: number; latitude: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  return upsertCourierProfile(oxyUserId, { longitude, latitude, lastPingAt: new Date() }, db);
}

/** Update the courier's editable payout preference. */
export async function updateCourierPayoutAccountRef(
  oxyUserId: string,
  payoutAccountRef: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  return upsertCourierProfile(oxyUserId, { payoutAccountRef }, db);
}

/** Write the capability cache recomputed from the active vehicle. */
export async function updateCourierCapability(
  oxyUserId: string,
  patch: CourierCapabilityPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow> {
  return upsertCourierProfile(
    oxyUserId,
    {
      eligibleJobTypes: patch.eligibleJobTypes,
      maxWeightKg: patch.maxWeightKg,
      maxSizeClass: patch.maxSizeClass,
      ...(patch.activeVehicleId === undefined ? {} : { activeVehicleId: patch.activeVehicleId }),
    },
    db,
  );
}

/** Mark the courier busy on a job. No caller reads the count. */
export async function markCourierOnJob(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(courierProfiles)
    .set({ onlineStatus: 'on_job' })
    .where(eq(courierProfiles.oxyUserId, oxyUserId));
}

/** Store a recomputed acceptance rate. Best-effort; no caller reads the count. */
export async function updateCourierAcceptanceRate(
  oxyUserId: string,
  acceptanceRate: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(courierProfiles)
    .set({ acceptanceRate })
    .where(eq(courierProfiles.oxyUserId, oxyUserId));
}

/**
 * Suspend a courier, answering whether anything was actually suspended.
 *
 * `status <> 'suspended'` is the source's `{status: {$ne: 'suspended'}}` and it
 * is what makes the returned boolean meaningful: a re-run of the same decision
 * matches nothing and reports `false`, so the audit trail does not record a
 * second suspension of an already-suspended courier as a fresh effect. `false`
 * also covers "no profile at all", which is a real outcome the source
 * deliberately reports rather than treating as success.
 *
 * `online_status` drops to `offline` with the suspension and is deliberately NOT
 * restored by {@link reinstateCourier} — availability is the courier's to set.
 */
export async function suspendCourier(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(courierProfiles)
    .set({ status: 'suspended', onlineStatus: 'offline' })
    .where(
      and(
        eq(courierProfiles.oxyUserId, oxyUserId),
        not(eq(courierProfiles.status, 'suspended')),
      ),
    );
  return (result.count ?? 0) > 0;
}

/**
 * Undo a suspension, answering whether there was one to undo.
 *
 * Only from `suspended`, and to `active` rather than to whatever the profile
 * held before: a profile still `pending` verification was never suspended by
 * Moovo and must not be promoted to `active` by an unrelated appeal.
 */
export async function reinstateCourier(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(courierProfiles)
    .set({ status: 'active' })
    .where(
      and(eq(courierProfiles.oxyUserId, oxyUserId), eq(courierProfiles.status, 'suspended')),
    );
  return (result.count ?? 0) > 0;
}

/** What dispatch needs to find candidates for one job. */
export interface DispatchCandidateQuery {
  pickup: { longitude: number; latitude: number };
  radiusM: number;
  jobType: string;
  weightKg: number;
  stalePingCutoff: Date;
  excludeOxyUserIds: readonly string[];
  limit: number;
}

/**
 * Candidate couriers for a job, NEAREST FIRST.
 *
 * The ordering is the product, not a detail. `dispatch.service` chains
 * `.limit(waveSize)` with NO `.sort()`, so `$nearSphere`'s nearest-first order
 * IS the result and the wave goes to the closest couriers. A port that filtered
 * by radius and let Postgres return rows in whatever order it liked would still
 * return "eligible couriers" and would offer the job to the wrong ones — a
 * defect with no error and no symptom except worse delivery times. Hence
 * `ORDER BY location <-> point`, which is also what lets the GiST index serve
 * the ordering rather than sorting the whole candidate set.
 *
 * `ST_DWithin` is the `$maxDistance` half. A courier who has never pinged has a
 * NULL location, so the predicate is NULL and they are excluded — exactly what
 * `sparse: true` did for the `2dsphere` index, and why the GiST index here is
 * PARTIAL on `location is not null`.
 *
 * There is deliberately NO `status = 'active'` predicate, because the source has
 * none — and that omission is load-bearing to reproduce rather than quietly
 * improve. It leaves a real gap: `suspendCourier` sets `online_status` to
 * `offline`, but nothing stops a suspended courier calling `goOnline` and
 * re-entering this result set, so a suspension only holds while they leave their
 * availability alone. Closing it is a ONE-predicate change and is deliberately
 * not made here: landing a moderation-enforcement change inside a storage port
 * makes any behaviour complaint afterwards impossible to attribute to one or the
 * other. It is reported with this PR as its own decision.
 *
 * `= any(eligible_job_types)` is array CONTAINMENT — the port of Mongo's
 * `{eligibleJobTypes: <one value>}`. `eq()` would compare the whole array to a
 * scalar and silently match nothing, so dispatch would find no couriers at all
 * and read as "nobody is online".
 */
export async function findDispatchCandidates(
  query: DispatchCandidateQuery,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierProfileRow[]> {
  const point = sql`ST_SetSRID(ST_MakePoint(${query.pickup.longitude}, ${query.pickup.latitude}), 4326)::geography`;

  return await db
    .select()
    .from(courierProfiles)
    .where(
      and(
        eq(courierProfiles.onlineStatus, 'online'),
        gte(courierProfiles.lastPingAt, query.stalePingCutoff),
        sql`${query.jobType} = any(${courierProfiles.eligibleJobTypes})`,
        gte(courierProfiles.maxWeightKg, query.weightKg),
        isNotNull(courierProfiles.location),
        sql`ST_DWithin(${courierProfiles.location}, ${point}, ${query.radiusM})`,
        ...(query.excludeOxyUserIds.length > 0
          ? [not(inArray(courierProfiles.oxyUserId, [...query.excludeOxyUserIds]))]
          : []),
      ),
    )
    .orderBy(asc(sql`${courierProfiles.location} <-> ${point}`))
    .limit(query.limit);
}

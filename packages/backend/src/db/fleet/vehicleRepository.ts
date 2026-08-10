/**
 * Every statement this service issues against `vehicles`.
 *
 * `vehicle.ts`'s `pre('validate')` hook — ownership is EITHER a courier or a
 * company, never both, never neither — is now `vehicles_owner_shape_check` in
 * the schema. Per CONVENTIONS.md the rule is NOT re-expressed here: a hook
 * re-implemented at a write chokepoint restores exactly the race the hook never
 * closed (two concurrent writers both pass the check), while looking like
 * belt-and-braces. The constraint is the enforcement; this module's job is to
 * write rows and let `23514` surface.
 *
 * `capacity` flattens into columns rather than jsonb, so the nested value object
 * is reassembled on read — the `shipmentShape` division of labour, small enough
 * to live in this file.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { JobType, VehicleType } from '@moovo/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { vehicles } from '../schema/fleet';

/** A `vehicles` row exactly as stored. */
export type VehicleRow = typeof vehicles.$inferSelect;

/** The parcel capacity of one vehicle, as its consumers read it. */
export interface VehicleCapacityValue {
  maxWeightKg: number;
  maxVolumeL?: number;
  maxDimsCm?: { l: number; w: number; h: number };
}

/** A vehicle in the shape the services and DTOs consume. */
export interface VehicleRecord {
  id: string;
  ownerType: VehicleOwnerType;
  courierOxyUserId?: string;
  companyId?: string;
  type: VehicleType;
  label?: string;
  plate?: string;
  capacity: VehicleCapacityValue;
  eligibleJobTypes: JobType[];
  status: VehicleStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** The two closed sets this table declares that shared-types does not name. */
export type VehicleOwnerType = 'courier' | 'company';
export type VehicleStatus = 'active' | 'inactive';

/**
 * Reassemble the nested record from one flat row.
 *
 * `maxDimsCm` is present only when ALL THREE ordinates are — the source's
 * optional `maxDimsCm` sub-object could not express a partial `{l, w}` and
 * three nullable columns can, so the reassembly is where it is refused.
 */
export function toVehicleRecord(row: VehicleRow): VehicleRecord {
  const capacity: VehicleCapacityValue = { maxWeightKg: row.maxWeightKg };
  if (row.maxVolumeL !== null) capacity.maxVolumeL = row.maxVolumeL;
  if (
    row.maxDimsL !== null &&
    row.maxDimsW !== null &&
    row.maxDimsH !== null
  ) {
    capacity.maxDimsCm = {
      l: row.maxDimsL,
      w: row.maxDimsW,
      h: row.maxDimsH,
    };
  }

  const record: VehicleRecord = {
    id: row.id,
    /**
     * The four narrowings below are the column CHECKs, restated for the
     * compiler: `vehicles_owner_type_check`, `_type_check`, `_status_check` and
     * `_eligible_job_types_check` are each rendered from the same `as const`
     * tuple that defines the union, so a value outside it cannot be stored —
     * but drizzle types a `text` column as `string` and cannot know that.
     */
    ownerType: row.ownerType as VehicleOwnerType,
    type: row.type as VehicleType,
    capacity,
    eligibleJobTypes: row.eligibleJobTypes as JobType[],
    status: row.status as VehicleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.courierOxyUserId !== null) record.courierOxyUserId = row.courierOxyUserId;
  if (row.companyId !== null) record.companyId = row.companyId;
  if (row.label !== null) record.label = row.label;
  if (row.plate !== null) record.plate = row.plate;
  return record;
}

/** What creating a vehicle needs. The caller decides the owner; the CHECK polices it. */
export interface NewVehicle {
  ownerType: string;
  courierOxyUserId?: string | undefined;
  companyId?: string | undefined;
  type: string;
  label?: string | undefined;
  plate?: string | undefined;
  capacity: VehicleCapacityValue;
  eligibleJobTypes: string[];
}

/** The mutable fields of a vehicle. */
export interface VehiclePatch {
  label?: string | undefined;
  plate?: string | undefined;
  type?: string | undefined;
  capacity?: VehicleCapacityValue | undefined;
  eligibleJobTypes?: string[] | undefined;
  status?: string | undefined;
}

function capacityColumns(capacity: VehicleCapacityValue) {
  return {
    maxWeightKg: capacity.maxWeightKg,
    maxVolumeL: capacity.maxVolumeL ?? null,
    maxDimsL: capacity.maxDimsCm?.l ?? null,
    maxDimsW: capacity.maxDimsCm?.w ?? null,
    maxDimsH: capacity.maxDimsCm?.h ?? null,
  };
}

export async function insertVehicle(
  input: NewVehicle,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleRecord> {
  const [row] = await db
    .insert(vehicles)
    .values({
      id: uuidv7(),
      ownerType: input.ownerType,
      courierOxyUserId: input.courierOxyUserId ?? null,
      companyId: input.companyId ?? null,
      type: input.type,
      label: input.label ?? null,
      plate: input.plate ?? null,
      eligibleJobTypes: input.eligibleJobTypes,
      ...capacityColumns(input.capacity),
    })
    .returning();
  if (!row) throw new Error('Inserting a vehicle returned no row');
  return toVehicleRecord(row);
}

export async function findVehicleById(
  vehicleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleRecord | null> {
  const [row] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
  return row ? toVehicleRecord(row) : null;
}

/**
 * The courier's own vehicles.
 *
 * `owner_type = 'courier'` is stated explicitly rather than left to the
 * ownership CHECK: this is the query that stands in for the deleted
 * `courier_profiles.vehicleIds` array, so it must never widen to a
 * company-owned vehicle the courier merely drives.
 */
export async function listVehiclesForCourier(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleRecord[]> {
  const rows = await db
    .select()
    .from(vehicles)
    .where(
      and(eq(vehicles.ownerType, 'courier'), eq(vehicles.courierOxyUserId, oxyUserId)),
    )
    // Newest first, the source's `.sort({createdAt: -1})`. `id` breaks ties so
    // the order is total; it is uuid v7 and means nothing chronological here.
    .orderBy(desc(vehicles.createdAt), desc(vehicles.id));
  return rows.map(toVehicleRecord);
}

export async function listVehiclesForCompany(
  companyId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleRecord[]> {
  const rows = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.ownerType, 'company'), eq(vehicles.companyId, companyId)))
    .orderBy(desc(vehicles.createdAt), desc(vehicles.id));
  return rows.map(toVehicleRecord);
}

export async function updateVehicleRow(
  vehicleId: string,
  patch: VehiclePatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleRecord | null> {
  const set: Partial<typeof vehicles.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.plate !== undefined) set.plate = patch.plate;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.eligibleJobTypes !== undefined) set.eligibleJobTypes = patch.eligibleJobTypes;
  if (patch.capacity !== undefined) Object.assign(set, capacityColumns(patch.capacity));

  if (Object.keys(set).length === 0) {
    return findVehicleById(vehicleId, db);
  }
  const [row] = await db.update(vehicles).set(set).where(eq(vehicles.id, vehicleId)).returning();
  return row ? toVehicleRecord(row) : null;
}

/**
 * Hard-delete a vehicle.
 *
 * `courier_profiles.active_vehicle_id` references this row `ON DELETE SET
 * NULL`, so deleting the courier's active vehicle clears the pointer rather
 * than dangling — which is load-bearing rather than decorative precisely
 * because this really is a hard delete.
 */
export async function deleteVehicleRow(
  vehicleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  return (result.count ?? 0) > 0;
}

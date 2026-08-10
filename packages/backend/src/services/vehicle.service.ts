/**
 * Vehicle service.
 *
 * Owns CRUD for vehicles owned by a courier (`ownerType: 'courier'`) or a
 * company (`ownerType: 'company'`). On every create/update, `eligibleJobTypes`
 * and the default capacity weight are DENORMALIZED from `capability.service`'s
 * declarative rules for the vehicle's `type` — the single source of truth.
 *
 * Ownership is enforced HERE by throwing typed `MoovoError`s
 * (`NOT_FOUND`/`FORBIDDEN`) that thin controllers map onto the response. This
 * service has NO dependency on `courier-profile.service` (the courier profile
 * imports this one) to avoid a cycle.
 */

import type { CreateVehicleInput, JobType } from '@moovo/shared-types';
import {
  deleteVehicleRow,
  findVehicleById,
  insertVehicle,
  listVehiclesForCompany,
  listVehiclesForCourier,
  updateVehicleRow,
  type VehicleCapacityValue,
  type VehicleRecord,
} from '../db/fleet/vehicleRepository.js';
import { computeVehicleCapability } from './capability.service.js';
import { forbidden, notFound } from '../lib/errors/error-codes.js';

/** Identifies which owner a vehicle operation is scoped to. */
export type VehicleOwner =
  | { ownerType: 'courier'; courierOxyUserId: string }
  | { ownerType: 'company'; companyId: string };

/** Editable vehicle fields (capability is always recomputed from `type`). */
export interface UpdateVehicleInput {
  type?: CreateVehicleInput['type'];
  label?: string;
  plate?: string;
  capacity?: CreateVehicleInput['capacity'];
  status?: VehicleRecord['status'];
}

/**
 * Build the persisted capacity from an input + the type's capability default.
 * An explicit `maxWeightKg` is honoured; otherwise it falls back to the
 * capability table's max weight for that vehicle type.
 */
function buildCapacity(
  type: CreateVehicleInput['type'],
  input: CreateVehicleInput['capacity'],
): { capacity: VehicleCapacityValue; eligibleJobTypes: JobType[] } {
  const capability = computeVehicleCapability(type);
  const capacity: VehicleCapacityValue = {
    maxWeightKg: input?.maxWeightKg ?? capability.maxWeightKg,
  };
  if (input?.maxVolumeL !== undefined) {
    capacity.maxVolumeL = input.maxVolumeL;
  }
  if (input?.maxDimsCm !== undefined) {
    capacity.maxDimsCm = input.maxDimsCm;
  }
  return { capacity, eligibleJobTypes: capability.eligibleJobTypes };
}

/** List the vehicles a courier owns (newest first). */
export async function listForCourier(courierOxyUserId: string): Promise<VehicleRecord[]> {
  return listVehiclesForCourier(courierOxyUserId);
}

/** List the vehicles a company owns (newest first). */
export async function listForCompany(companyId: string): Promise<VehicleRecord[]> {
  return listVehiclesForCompany(companyId);
}

/** Fetch a vehicle by id, or throw NOT_FOUND. */
export async function getById(vehicleId: string): Promise<VehicleRecord> {
  const vehicle = await findVehicleById(vehicleId);
  if (!vehicle) {
    throw notFound('Vehicle not found');
  }
  return vehicle;
}

/** Create a vehicle owned by a courier. */
export async function createForCourier(
  courierOxyUserId: string,
  input: CreateVehicleInput,
): Promise<VehicleRecord> {
  const { capacity, eligibleJobTypes } = buildCapacity(input.type, input.capacity);
  return insertVehicle({
    ownerType: 'courier',
    courierOxyUserId,
    type: input.type,
    ...(input.label ? { label: input.label } : {}),
    ...(input.plate ? { plate: input.plate } : {}),
    capacity,
    eligibleJobTypes,
  });
}

/** Create a vehicle owned by a company. */
export async function createForCompany(
  companyId: string,
  input: CreateVehicleInput,
): Promise<VehicleRecord> {
  const { capacity, eligibleJobTypes } = buildCapacity(input.type, input.capacity);
  return insertVehicle({
    ownerType: 'company',
    companyId,
    type: input.type,
    ...(input.label ? { label: input.label } : {}),
    ...(input.plate ? { plate: input.plate } : {}),
    capacity,
    eligibleJobTypes,
  });
}

/** Assert that `vehicle` is owned by `owner`, else throw FORBIDDEN. */
function assertOwnership(vehicle: VehicleRecord, owner: VehicleOwner): void {
  if (owner.ownerType === 'courier') {
    if (vehicle.ownerType !== 'courier' || vehicle.courierOxyUserId !== owner.courierOxyUserId) {
      throw forbidden('You do not own this vehicle');
    }
  } else if (vehicle.ownerType !== 'company' || vehicle.companyId !== owner.companyId) {
    throw forbidden('This vehicle does not belong to your company');
  }
}

/**
 * Update a vehicle the `owner` owns. Changing `type` recomputes the denormalized
 * `eligibleJobTypes` + default capacity weight from the capability table.
 */
export async function updateVehicle(
  vehicleId: string,
  owner: VehicleOwner,
  patch: UpdateVehicleInput,
): Promise<VehicleRecord> {
  const vehicle = await findVehicleById(vehicleId);
  if (!vehicle) {
    throw notFound('Vehicle not found');
  }
  assertOwnership(vehicle, owner);

  const set: Parameters<typeof updateVehicleRow>[1] = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.plate !== undefined) set.plate = patch.plate;
  if (patch.status !== undefined) set.status = patch.status;

  // If the type changes, recompute capability; otherwise merge capacity overrides
  // onto the existing type.
  const nextType = (patch.type ?? vehicle.type) as CreateVehicleInput['type'];
  if (patch.type !== undefined || patch.capacity !== undefined) {
    const { capacity, eligibleJobTypes } = buildCapacity(nextType, {
      maxWeightKg: patch.capacity?.maxWeightKg,
      maxVolumeL: patch.capacity?.maxVolumeL,
      maxDimsCm: patch.capacity?.maxDimsCm,
    });
    set.type = nextType;
    set.capacity = capacity;
    set.eligibleJobTypes = eligibleJobTypes;
  }

  const updated = await updateVehicleRow(vehicleId, set);
  if (!updated) {
    throw notFound('Vehicle not found');
  }
  return updated;
}

/** Delete a vehicle the `owner` owns. */
export async function deleteVehicle(vehicleId: string, owner: VehicleOwner): Promise<void> {
  const vehicle = await findVehicleById(vehicleId);
  if (!vehicle) {
    throw notFound('Vehicle not found');
  }
  assertOwnership(vehicle, owner);
  await deleteVehicleRow(vehicleId);
}

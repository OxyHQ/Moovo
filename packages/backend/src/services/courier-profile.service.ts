/**
 * Courier-profile service.
 *
 * Owns the lazy lifecycle + availability + capability cache of an individual
 * courier's Moovo profile (`CourierProfile`), keyed by Oxy user id. Display
 * identity (name/avatar) is NEVER stored here — it is read live from Oxy at
 * hydration time; this service only manages the Moovo-owned aggregates,
 * online/offline state, the location ping, and the denormalized capability cache
 * (recomputed from the active vehicle via `capability.service`).
 *
 * Vehicle CRUD lives in `vehicle.service`; this module owns the courier's
 * `vehicleIds`/`activeVehicleId` bookkeeping and capability projection.
 */

import type { CreateVehicleInput, OnlineStatus } from '@moovo/shared-types';
import {
  ensureCourierProfile,
  findCourierProfile,
  recordCourierPing,
  setCourierOnlineIfPermitted,
  setCourierOnlineStatus,
  updateCourierCapability,
  updateCourierPayoutAccountRef,
  type CourierProfileRow,
} from '../db/fleet/courierProfileRepository.js';
import type { VehicleRecord } from '../db/fleet/vehicleRepository.js';
import {
  createForCourier,
  deleteVehicle,
  getById,
  listForCourier,
  updateVehicle,
  type UpdateVehicleInput,
} from './vehicle.service.js';
import { computeVehicleCapability } from './capability.service.js';
import { forbidden } from '../lib/errors/error-codes.js';

/**
 * Get the courier profile for `oxyUserId`, creating an empty one on first use
 * (lazy). Idempotent under concurrent first-writes via an upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<CourierProfileRow> {
  return ensureCourierProfile(oxyUserId);
}

/** Return the courier's own profile, creating it lazily if absent. */
export async function getMine(oxyUserId: string): Promise<CourierProfileRow> {
  return getOrCreate(oxyUserId);
}

/** Editable courier preference fields. */
export interface CourierPrefsInput {
  payout?: {
    accountRef?: string;
  };
}

/** Update the courier's editable preferences (lazily creating the profile). */
export async function updatePrefs(
  oxyUserId: string,
  prefs: CourierPrefsInput,
): Promise<CourierProfileRow> {
  if (prefs.payout?.accountRef === undefined) {
    // Nothing editable was supplied, so this is a plain get-or-create — NOT an
    // update writing the same values back, which would bump `updated_at`.
    return ensureCourierProfile(oxyUserId);
  }
  return updateCourierPayoutAccountRef(oxyUserId, prefs.payout.accountRef);
}

/** Set the courier's availability. Does not flip `on_job` (that is job-driven). */
async function setOnlineStatus(
  oxyUserId: string,
  onlineStatus: OnlineStatus,
): Promise<CourierProfileRow> {
  return setCourierOnlineStatus(oxyUserId, onlineStatus);
}

/**
 * Mark the courier online — unless they are suspended.
 *
 * The other half of the suspension fix. `suspendCourier` drops a courier
 * `offline`, and without this check they simply toggled themselves back and
 * re-entered dispatch: a suspension held only for as long as the suspended
 * person left their availability alone. The dispatch predicate stops them being
 * OFFERED work; this stops them entering the pool at all, and the two fail
 * differently — neither alone closes both paths.
 *
 * Going OFFLINE is deliberately unguarded: a suspended courier must always be
 * able to stop receiving work.
 */
export async function goOnline(oxyUserId: string): Promise<CourierProfileRow> {
  const profile = await setCourierOnlineIfPermitted(oxyUserId);
  if (!profile) {
    throw forbidden('Your courier account is suspended and cannot go online');
  }
  return profile;
}

/** Mark the courier offline. */
export async function goOffline(oxyUserId: string): Promise<CourierProfileRow> {
  return setOnlineStatus(oxyUserId, 'offline');
}

/** Record a location ping (GeoJSON point + timestamp). */
export async function pingLocation(
  oxyUserId: string,
  lng: number,
  lat: number,
): Promise<CourierProfileRow> {
  return recordCourierPing(oxyUserId, { longitude: lng, latitude: lat });
}

/** List the courier's vehicles. */
export async function listVehicles(oxyUserId: string): Promise<VehicleRecord[]> {
  return listForCourier(oxyUserId);
}

/** Create a vehicle for the courier and track it on the profile. */
export async function addVehicle(
  oxyUserId: string,
  input: CreateVehicleInput,
): Promise<VehicleRecord> {
  const vehicle = await createForCourier(oxyUserId, input);
  // The source's `trackVehicle` pushed the id onto `courier_profiles.vehicleIds`
  // AND upserted the profile. The array is gone — `listVehicles` derives it from
  // `vehicles` — but the profile creation is NOT incidental: without it a courier
  // can own a vehicle while having no profile row at all.
  await ensureCourierProfile(oxyUserId);
  return vehicle;
}

/** Update one of the courier's vehicles. */
export async function patchVehicle(
  oxyUserId: string,
  vehicleId: string,
  patch: UpdateVehicleInput,
): Promise<VehicleRecord> {
  return updateVehicle(vehicleId, { ownerType: 'courier', courierOxyUserId: oxyUserId }, patch);
}

/**
 * Remove one of the courier's vehicles, untracking it from the profile and
 * clearing the capability cache if it was the active vehicle.
 */
export async function removeVehicle(oxyUserId: string, vehicleId: string): Promise<void> {
  const profile = await findCourierProfile(oxyUserId);
  const wasActive = profile?.activeVehicleId === vehicleId;

  await deleteVehicle(vehicleId, { ownerType: 'courier', courierOxyUserId: oxyUserId });

  // `courier_profiles.active_vehicle_id` references the deleted row `ON DELETE
  // SET NULL`, so the pointer is already cleared by the delete itself. What the
  // database cannot do is reset the CAPABILITY CACHE that vehicle populated —
  // leaving it would advertise a courier as able to carry a load they no longer
  // have a vehicle for, which dispatch reads as eligibility.
  if (wasActive) {
    await updateCourierCapability(oxyUserId, {
      eligibleJobTypes: [],
      maxWeightKg: 0,
      maxSizeClass: 'small',
    });
  }
}

/**
 * Set the courier's active vehicle and recompute the denormalized capability
 * cache from that vehicle's type. The vehicle must belong to the courier.
 */
export async function setActiveVehicle(
  oxyUserId: string,
  vehicleId: string,
): Promise<CourierProfileRow> {
  const vehicle = await getById(vehicleId);
  if (vehicle.ownerType !== 'courier' || vehicle.courierOxyUserId !== oxyUserId) {
    throw forbidden('You do not own this vehicle');
  }

  const capability = computeVehicleCapability(vehicle.type);

  return updateCourierCapability(oxyUserId, {
    activeVehicleId: vehicleId,
    eligibleJobTypes: capability.eligibleJobTypes,
    maxWeightKg: capability.maxWeightKg,
    maxSizeClass: capability.maxSizeClass,
  });
}

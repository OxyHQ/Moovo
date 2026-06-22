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
import { CourierProfile, type ICourierProfile } from '../models/courier-profile.js';
import type { IVehicle } from '../models/vehicle.js';
import {
  createForCourier,
  deleteVehicle,
  getById,
  listForCourier,
  updateVehicle,
  type UpdateVehicleInput,
} from './vehicle.service.js';
import { computeVehicleCapability } from './capability.service.js';
import { forbidden, notFound } from '../lib/errors/error-codes.js';

/**
 * Get the courier profile for `oxyUserId`, creating an empty one on first use
 * (lazy). Idempotent under concurrent first-writes via an upsert.
 */
export async function getOrCreate(oxyUserId: string): Promise<ICourierProfile> {
  const profile = await CourierProfile.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId } },
    { returnDocument: 'after', upsert: true },
  ).lean<ICourierProfile>();
  return profile;
}

/** Return the courier's own profile, creating it lazily if absent. */
export async function getMine(oxyUserId: string): Promise<ICourierProfile> {
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
): Promise<ICourierProfile> {
  const set: Record<string, unknown> = {};
  if (prefs.payout?.accountRef !== undefined) {
    set['payout.accountRef'] = prefs.payout.accountRef;
  }

  const profile = await CourierProfile.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId }, ...(Object.keys(set).length > 0 ? { $set: set } : {}) },
    { returnDocument: 'after', upsert: true },
  ).lean<ICourierProfile>();
  return profile;
}

/** Set the courier's availability. Does not flip `on_job` (that is job-driven). */
async function setOnlineStatus(
  oxyUserId: string,
  onlineStatus: OnlineStatus,
): Promise<ICourierProfile> {
  const profile = await CourierProfile.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId }, $set: { onlineStatus } },
    { returnDocument: 'after', upsert: true },
  ).lean<ICourierProfile>();
  return profile;
}

/** Mark the courier online. */
export async function goOnline(oxyUserId: string): Promise<ICourierProfile> {
  return setOnlineStatus(oxyUserId, 'online');
}

/** Mark the courier offline. */
export async function goOffline(oxyUserId: string): Promise<ICourierProfile> {
  return setOnlineStatus(oxyUserId, 'offline');
}

/** Record a location ping (GeoJSON point + timestamp). */
export async function pingLocation(
  oxyUserId: string,
  lng: number,
  lat: number,
): Promise<ICourierProfile> {
  const profile = await CourierProfile.findOneAndUpdate(
    { oxyUserId },
    {
      $setOnInsert: { oxyUserId },
      $set: {
        currentLocation: { type: 'Point', coordinates: [lng, lat] },
        lastPingAt: new Date(),
      },
    },
    { returnDocument: 'after', upsert: true },
  ).lean<ICourierProfile>();
  return profile;
}

/** Add a vehicle id to the courier's `vehicleIds` set (idempotent). */
async function trackVehicle(oxyUserId: string, vehicleId: string): Promise<void> {
  await CourierProfile.updateOne(
    { oxyUserId },
    { $setOnInsert: { oxyUserId }, $addToSet: { vehicleIds: vehicleId } },
    { upsert: true },
  );
}

/** List the courier's vehicles. */
export async function listVehicles(oxyUserId: string): Promise<IVehicle[]> {
  return listForCourier(oxyUserId);
}

/** Create a vehicle for the courier and track it on the profile. */
export async function addVehicle(
  oxyUserId: string,
  input: CreateVehicleInput,
): Promise<IVehicle> {
  const vehicle = await createForCourier(oxyUserId, input);
  await trackVehicle(oxyUserId, String(vehicle._id));
  return vehicle;
}

/** Update one of the courier's vehicles. */
export async function patchVehicle(
  oxyUserId: string,
  vehicleId: string,
  patch: UpdateVehicleInput,
): Promise<IVehicle> {
  return updateVehicle(vehicleId, { ownerType: 'courier', courierOxyUserId: oxyUserId }, patch);
}

/**
 * Remove one of the courier's vehicles, untracking it from the profile and
 * clearing the capability cache if it was the active vehicle.
 */
export async function removeVehicle(oxyUserId: string, vehicleId: string): Promise<void> {
  await deleteVehicle(vehicleId, { ownerType: 'courier', courierOxyUserId: oxyUserId });
  const profile = await CourierProfile.findOne({ oxyUserId });
  if (!profile) {
    return;
  }
  profile.vehicleIds = profile.vehicleIds.filter((id) => id !== vehicleId);
  if (profile.activeVehicleId === vehicleId) {
    profile.activeVehicleId = undefined;
    profile.eligibleJobTypes = [];
    profile.maxWeightKg = 0;
    profile.maxSizeClass = 'small';
  }
  await profile.save();
}

/**
 * Set the courier's active vehicle and recompute the denormalized capability
 * cache from that vehicle's type. The vehicle must belong to the courier.
 */
export async function setActiveVehicle(
  oxyUserId: string,
  vehicleId: string,
): Promise<ICourierProfile> {
  const vehicle = await getById(vehicleId);
  if (vehicle.ownerType !== 'courier' || vehicle.courierOxyUserId !== oxyUserId) {
    throw forbidden('You do not own this vehicle');
  }

  const capability = computeVehicleCapability(vehicle.type);

  const profile = await CourierProfile.findOneAndUpdate(
    { oxyUserId },
    {
      $setOnInsert: { oxyUserId },
      $addToSet: { vehicleIds: vehicleId },
      $set: {
        activeVehicleId: vehicleId,
        eligibleJobTypes: capability.eligibleJobTypes,
        maxWeightKg: capability.maxWeightKg,
        maxSizeClass: capability.maxSizeClass,
      },
    },
    { returnDocument: 'after', upsert: true },
  ).lean<ICourierProfile | null>();

  if (!profile) {
    throw notFound('Courier profile not found');
  }
  return profile;
}

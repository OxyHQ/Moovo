/**
 * Courier-profile controller (THIN).
 *
 * Serves the individual courier's own profile, availability, location ping, and
 * vehicle management under `/courier`. All logic lives in
 * `courier-profile.service` (profile + vehicle bookkeeping + capability cache)
 * and `vehicle.service` (vehicle docs). Vehicles are serialized to the wire
 * `Vehicle` DTO.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CreateVehicleInput, Vehicle as VehicleDTO } from '@moovo/shared-types';
import type { CourierProfileRow } from '../db/fleet/courierProfileRepository.js';
import {
  listVehiclesForCourier,
  type VehicleRecord,
} from '../db/fleet/vehicleRepository.js';
import {
  getMine,
  updatePrefs,
  goOnline,
  goOffline,
  pingLocation,
  listVehicles,
  addVehicle,
  patchVehicle,
  removeVehicle,
  setActiveVehicle,
  type CourierPrefsInput,
} from '../services/courier-profile.service.js';
import type { UpdateVehicleInput } from '../services/vehicle.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/**
 * Serialize a courier profile to the wire.
 *
 * ASYNC because `vehicleIds` is a WIRE field whose column no longer exists.
 * `courier_profiles.vehicleIds` was a hand-maintained cache of "which vehicles
 * does this courier own", and the schema drops it because a Postgres array
 * cannot carry a foreign key on its elements — a deleted vehicle would dangle
 * there forever. The list is DERIVED from `vehicles` instead, which is the same
 * query the array was a copy of, so the response is unchanged while the second
 * authority for the fact is gone.
 */
async function toCourierProfileResponse(
  profile: CourierProfileRow,
): Promise<Record<string, unknown>> {
  const vehicles = await listVehiclesForCourier(profile.oxyUserId);
  return {
    id: profile.id,
    oxyUserId: profile.oxyUserId,
    status: profile.status,
    onlineStatus: profile.onlineStatus,
    ...(profile.longitude !== null && profile.latitude !== null
      ? {
          currentLocation: {
            type: 'Point',
            coordinates: [profile.longitude, profile.latitude],
          },
        }
      : {}),
    ...(profile.lastPingAt ? { lastPingAt: profile.lastPingAt.toISOString() } : {}),
    vehicleIds: vehicles.map((vehicle) => vehicle.id),
    ...(profile.activeVehicleId ? { activeVehicleId: profile.activeVehicleId } : {}),
    eligibleJobTypes: [...profile.eligibleJobTypes],
    maxWeightKg: profile.maxWeightKg,
    maxSizeClass: profile.maxSizeClass,
    rating: profile.rating,
    reviewCount: profile.reviewCount,
    completedJobs: profile.completedJobs,
    cancelledJobs: profile.cancelledJobs,
    ...(profile.acceptanceRate !== null ? { acceptanceRate: profile.acceptanceRate } : {}),
    payout: {
      provider: profile.payoutProvider,
      ...(profile.payoutAccountRef ? { accountRef: profile.payoutAccountRef } : {}),
    },
    ...(profile.companyId ? { companyId: profile.companyId } : {}),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/** Serialize a vehicle document to the `Vehicle` DTO. */
function toVehicleDTO(vehicle: VehicleRecord): VehicleDTO {
  const dto: VehicleDTO = {
    id: vehicle.id,
    ownerType: vehicle.ownerType,
    type: vehicle.type,
    capacity: {
      maxWeightKg: vehicle.capacity.maxWeightKg,
      ...(vehicle.capacity.maxVolumeL !== undefined
        ? { maxVolumeL: vehicle.capacity.maxVolumeL }
        : {}),
      ...(vehicle.capacity.maxDimsCm !== undefined
        ? { maxDimsCm: vehicle.capacity.maxDimsCm }
        : {}),
    },
    eligibleJobTypes: [...vehicle.eligibleJobTypes],
    status: vehicle.status,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
  if (vehicle.courierOxyUserId) dto.courierOxyUserId = vehicle.courierOxyUserId;
  if (vehicle.companyId) dto.companyId = vehicle.companyId;
  if (vehicle.label) dto.label = vehicle.label;
  if (vehicle.plate) dto.plate = vehicle.plate;
  return dto;
}

/** GET /courier/me — the caller's courier profile (created lazily). */
export async function getMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await getMine(oxyUserId);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to load courier profile');
    respondWithError(res, err, 'Failed to load courier profile');
  }
}

/** PATCH /courier/me — update the caller's preferences. */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await updatePrefs(oxyUserId, req.body as CourierPrefsInput);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to update courier profile');
    respondWithError(res, err, 'Failed to update courier profile');
  }
}

/** POST /courier/online — mark the caller online. */
export async function goOnlineHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await goOnline(oxyUserId);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to set courier online');
    respondWithError(res, err, 'Failed to go online');
  }
}

/** POST /courier/offline — mark the caller offline. */
export async function goOfflineHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await goOffline(oxyUserId);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to set courier offline');
    respondWithError(res, err, 'Failed to go offline');
  }
}

/** POST /courier/location — record a location ping. */
export async function pingLocationHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { lng, lat } = req.body as { lng: number; lat: number };
    const profile = await pingLocation(oxyUserId, lng, lat);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to record courier location');
    respondWithError(res, err, 'Failed to record location');
  }
}

/** GET /courier/vehicles — the caller's vehicles. */
export async function listMyVehicles(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const vehicles = await listVehicles(oxyUserId);
    sendSuccess(res, vehicles.map(toVehicleDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list courier vehicles');
    respondWithError(res, err, 'Failed to load your vehicles');
  }
}

/** POST /courier/vehicles — create a vehicle for the caller. */
export async function createMyVehicle(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const vehicle = await addVehicle(oxyUserId, req.body as CreateVehicleInput);
    sendSuccess(res, toVehicleDTO(vehicle), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create courier vehicle');
    respondWithError(res, err, 'Failed to create vehicle');
  }
}

/** PATCH /courier/vehicles/:id — update one of the caller's vehicles. */
export async function updateMyVehicle(req: Request, res: Response): Promise<void> {
  const vehicleId = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const vehicle = await patchVehicle(oxyUserId, vehicleId, req.body as UpdateVehicleInput);
    sendSuccess(res, toVehicleDTO(vehicle));
  } catch (err) {
    log.general.error({ err, vehicleId }, 'Failed to update courier vehicle');
    respondWithError(res, err, 'Failed to update vehicle');
  }
}

/** DELETE /courier/vehicles/:id — remove one of the caller's vehicles. */
export async function deleteMyVehicle(req: Request, res: Response): Promise<void> {
  const vehicleId = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await removeVehicle(oxyUserId, vehicleId);
    sendSuccess(res, { id: vehicleId });
  } catch (err) {
    log.general.error({ err, vehicleId }, 'Failed to delete courier vehicle');
    respondWithError(res, err, 'Failed to delete vehicle');
  }
}

/** POST /courier/active-vehicle — set the caller's active vehicle. */
export async function setActiveVehicleHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { vehicleId } = req.body as { vehicleId: string };
    const profile = await setActiveVehicle(oxyUserId, vehicleId);
    sendSuccess(res, await toCourierProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to set active vehicle');
    respondWithError(res, err, 'Failed to set active vehicle');
  }
}

/**
 * Company-admin controller (THIN) — company create/list/get/update + company
 * vehicle (fleet) management.
 *
 * `POST /admin/companies` and `GET /admin/companies` operate on the CALLER (no
 * `loadCompany`): create makes the caller the owner; list returns the caller's
 * companies. `GET/PATCH /admin/companies/:companyId` and the nested vehicle
 * routes operate on the already-loaded `req.company` (resolved + authorized by
 * `loadCompany`). All business logic lives in `courier-company.service` /
 * `vehicle.service`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  CreateVehicleInput,
  Company as CompanyDTO,
  Vehicle as VehicleDTO,
} from '@moovo/shared-types';
import type { ICompany } from '../../models/courier-company.js';
import type { IVehicle } from '../../models/vehicle.js';
import {
  createCompany,
  listCompaniesForUser,
  updateCompany,
} from '../../services/courier-company.service.js';
import {
  listForCompany,
  createForCompany,
  updateVehicle,
  deleteVehicle,
  type UpdateVehicleInput,
} from '../../services/vehicle.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** Serialize a company document to the `Company` admin DTO. */
export function toCompanyDTO(company: ICompany): CompanyDTO {
  return {
    id: String((company as { _id: unknown })._id),
    handle: company.handle,
    name: company.name,
    description: company.description,
    ...(company.logoFileId ? { logoFileId: company.logoFileId } : {}),
    ...(company.coverFileId ? { coverFileId: company.coverFileId } : {}),
    brandColor: company.brandColor,
    textTone: company.textTone,
    status: company.status,
    members: company.members.map((m) => ({
      oxyUserId: m.oxyUserId,
      role: m.role,
      permissions: [...m.permissions],
      ...(m.joinedBy ? { joinedBy: m.joinedBy } : {}),
      joinedAt: m.joinedAt.toISOString(),
    })),
    serviceAreas: company.serviceAreas.map((a) => ({
      center: { type: 'Point', coordinates: [a.center.coordinates[0], a.center.coordinates[1]] },
      radiusM: a.radiusM,
    })),
    defaultCurrency: company.defaultCurrency as CompanyDTO['defaultCurrency'],
    rating: company.rating,
    reviewCount: company.reviewCount,
    completedJobs: company.completedJobs,
    payout: {
      provider: company.payout.provider,
      ...(company.payout.accountRef ? { accountRef: company.payout.accountRef } : {}),
    },
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

/** Serialize a company vehicle to the `Vehicle` DTO. */
function toVehicleDTO(vehicle: IVehicle): VehicleDTO {
  const dto: VehicleDTO = {
    id: String((vehicle as { _id: unknown })._id),
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

/** Read the loaded company id, or respond 500 if missing. */
function loadedCompanyId(req: Request, res: Response): string | null {
  const company = req.company;
  if (!company) {
    respondWithError(res, undefined, 'Company not loaded');
    return null;
  }
  return String((company as { _id: unknown })._id);
}

/** POST /admin/companies — create a company; the caller becomes its owner. */
export async function createCompanyHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const company = await createCompany(oxyUserId, req.body as CreateCompanyInput);
    sendSuccess(res, toCompanyDTO(company), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create company');
    respondWithError(res, err, 'Failed to create company');
  }
}

/** GET /admin/companies — the caller's companies. */
export async function listMyCompanies(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const companies = await listCompaniesForUser(oxyUserId);
    sendSuccess(res, companies.map(toCompanyDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list companies');
    respondWithError(res, err, 'Failed to load your companies');
  }
}

/** GET /admin/companies/:companyId — the loaded company (caller is a member). */
export function getCompanyHandler(req: Request, res: Response): void {
  // `loadCompany` guarantees req.company is set for this route.
  const company = req.company;
  if (!company) {
    respondWithError(res, undefined, 'Company not loaded');
    return;
  }
  sendSuccess(res, toCompanyDTO(company));
}

/** PATCH /admin/companies/:companyId — update the loaded company. */
export async function updateCompanyHandler(req: Request, res: Response): Promise<void> {
  const companyId = loadedCompanyId(req, res);
  if (!companyId) return;
  try {
    const updated = await updateCompany(companyId, req.body as UpdateCompanyInput);
    sendSuccess(res, toCompanyDTO(updated));
  } catch (err) {
    log.general.error({ err }, 'Failed to update company');
    respondWithError(res, err, 'Failed to update company');
  }
}

/** GET /admin/companies/:companyId/vehicles — the company's vehicles. */
export async function listCompanyVehicles(req: Request, res: Response): Promise<void> {
  const companyId = loadedCompanyId(req, res);
  if (!companyId) return;
  try {
    const vehicles = await listForCompany(companyId);
    sendSuccess(res, vehicles.map(toVehicleDTO));
  } catch (err) {
    log.general.error({ err, companyId }, 'Failed to list company vehicles');
    respondWithError(res, err, 'Failed to load company vehicles');
  }
}

/** POST /admin/companies/:companyId/vehicles — create a company vehicle. */
export async function createCompanyVehicle(req: Request, res: Response): Promise<void> {
  const companyId = loadedCompanyId(req, res);
  if (!companyId) return;
  try {
    const vehicle = await createForCompany(companyId, req.body as CreateVehicleInput);
    sendSuccess(res, toVehicleDTO(vehicle), 201);
  } catch (err) {
    log.general.error({ err, companyId }, 'Failed to create company vehicle');
    respondWithError(res, err, 'Failed to create vehicle');
  }
}

/** PATCH /admin/companies/:companyId/vehicles/:id — update a company vehicle. */
export async function updateCompanyVehicle(req: Request, res: Response): Promise<void> {
  const companyId = loadedCompanyId(req, res);
  if (!companyId) return;
  const vehicleId = routeParam(req, 'id');
  try {
    const vehicle = await updateVehicle(
      vehicleId,
      { ownerType: 'company', companyId },
      req.body as UpdateVehicleInput,
    );
    sendSuccess(res, toVehicleDTO(vehicle));
  } catch (err) {
    log.general.error({ err, companyId, vehicleId }, 'Failed to update company vehicle');
    respondWithError(res, err, 'Failed to update vehicle');
  }
}

/** DELETE /admin/companies/:companyId/vehicles/:id — remove a company vehicle. */
export async function deleteCompanyVehicle(req: Request, res: Response): Promise<void> {
  const companyId = loadedCompanyId(req, res);
  if (!companyId) return;
  const vehicleId = routeParam(req, 'id');
  try {
    await deleteVehicle(vehicleId, { ownerType: 'company', companyId });
    sendSuccess(res, { id: vehicleId });
  } catch (err) {
    log.general.error({ err, companyId, vehicleId }, 'Failed to delete company vehicle');
    respondWithError(res, err, 'Failed to delete vehicle');
  }
}

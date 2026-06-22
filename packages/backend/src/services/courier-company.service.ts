/**
 * Courier-company (fleet) service.
 *
 * Owns company lifecycle (create/update), membership management, and the
 * owner-protection invariants:
 *   - the LAST owner of a company can be neither removed nor demoted, and
 *   - only an `owner` may change or remove ANOTHER `owner`.
 *
 * These invariants live HERE (not in middleware) and are enforced by throwing
 * typed `MoovoError`s (`CONFLICT`/`FORBIDDEN`) that controllers map to the
 * response. The creating user becomes the sole `owner` with all permissions.
 */

import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  InviteCompanyMemberInput,
  UpdateCompanyMemberInput,
} from '@moovo/shared-types';
import {
  CourierCompany,
  ALL_COMPANY_PERMISSIONS,
  type ICompany,
  type ICompanyMember,
  type ICompanyServiceArea,
} from '../models/courier-company.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Default brand color for a company created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/** Count the owners currently on a company. */
function ownerCount(company: Pick<ICompany, 'members'>): number {
  return company.members.filter((m) => m.role === 'owner').length;
}

/** Map a service-area DTO to the persisted GeoJSON-center shape. */
function toServiceArea(area: NonNullable<CreateCompanyInput['serviceAreas']>[number]): ICompanyServiceArea {
  return {
    center: { type: 'Point', coordinates: [...area.center.coordinates] },
    radiusM: area.radiusM,
  };
}

/**
 * Create a company. The caller becomes its sole `owner` (granted every
 * permission). The handle is derived from the name and made unique.
 */
export async function createCompany(
  ownerOxyUserId: string,
  input: CreateCompanyInput,
): Promise<ICompany> {
  const handle = await ensureUniqueSlug(input.name, async (candidate) => {
    const existing = await CourierCompany.exists({ handle: candidate });
    return existing !== null;
  });

  if (handle.length === 0) {
    throw validationError('Company name must contain at least one alphanumeric character');
  }

  const member: ICompanyMember = {
    oxyUserId: ownerOxyUserId,
    role: 'owner',
    permissions: [...ALL_COMPANY_PERMISSIONS],
    joinedAt: new Date(),
  };

  const company = await CourierCompany.create({
    handle,
    name: input.name,
    description: input.description ?? '',
    brandColor: input.brandColor ?? DEFAULT_BRAND_COLOR,
    ...(input.logoFileId ? { logoFileId: input.logoFileId } : {}),
    ...(input.coverFileId ? { coverFileId: input.coverFileId } : {}),
    defaultCurrency: input.defaultCurrency ?? 'USD',
    serviceAreas: (input.serviceAreas ?? []).map(toServiceArea),
    status: 'active',
    members: [member],
  });

  return company.toObject();
}

/** Fetch a company by id, or throw NOT_FOUND. */
export async function getCompany(companyId: string): Promise<ICompany> {
  const company = await CourierCompany.findById(companyId).lean<ICompany | null>();
  if (!company) {
    throw notFound('Company not found');
  }
  return company;
}

/** List the companies the given user is a member of. */
export async function listCompaniesForUser(oxyUserId: string): Promise<ICompany[]> {
  return CourierCompany.find({ 'members.oxyUserId': oxyUserId })
    .sort({ createdAt: -1 })
    .lean<ICompany[]>();
}

/** Update a company's profile fields. Returns the updated company. */
export async function updateCompany(
  companyId: string,
  patch: UpdateCompanyInput,
): Promise<ICompany> {
  const company = await CourierCompany.findById(companyId);
  if (!company) {
    throw notFound('Company not found');
  }

  if (patch.name !== undefined) company.name = patch.name;
  if (patch.description !== undefined) company.description = patch.description;
  if (patch.brandColor !== undefined) company.brandColor = patch.brandColor;
  if (patch.logoFileId !== undefined) company.logoFileId = patch.logoFileId;
  if (patch.coverFileId !== undefined) company.coverFileId = patch.coverFileId;
  if (patch.defaultCurrency !== undefined) company.defaultCurrency = patch.defaultCurrency;
  if (patch.textTone !== undefined) company.textTone = patch.textTone;
  if (patch.status !== undefined) company.status = patch.status;
  if (patch.serviceAreas !== undefined) {
    company.serviceAreas = patch.serviceAreas.map(toServiceArea);
  }

  await company.save();
  return company.toObject();
}

/**
 * Invite (add) a member to a company. The acting member's role gates whether
 * they may grant an `owner` role (only an existing owner may create another
 * owner). Rejects duplicates.
 */
export async function inviteMember(
  companyId: string,
  actor: ICompanyMember,
  input: InviteCompanyMemberInput,
): Promise<ICompany> {
  const company = await CourierCompany.findById(companyId);
  if (!company) {
    throw notFound('Company not found');
  }

  if (company.members.some((m) => m.oxyUserId === input.oxyUserId)) {
    throw conflict('User is already a member of this company');
  }

  // Only an owner may mint another owner.
  if (input.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may grant the owner role');
  }

  company.members.push({
    oxyUserId: input.oxyUserId,
    role: input.role,
    permissions: input.permissions ?? [],
    joinedBy: actor.oxyUserId,
    joinedAt: new Date(),
  });

  await company.save();

  // Best-effort: notify the invited member. A notification failure must never
  // fail the invite itself.
  try {
    await sendNotification({
      userId: input.oxyUserId,
      type: 'company_member_invited',
      title: 'Company invitation',
      body: `You were added to ${company.name}`,
      data: { companyId: String(company._id), role: input.role },
    });
  } catch (err) {
    log.general.warn(
      { err, companyId: String(company._id) },
      'company_member_invited notification failed',
    );
  }

  return company.toObject();
}

/**
 * Update a member's role/permissions. Enforces:
 *   - only an owner may modify another owner,
 *   - demoting the last owner away from `owner` is rejected.
 */
export async function updateMember(
  companyId: string,
  actor: ICompanyMember,
  targetOxyUserId: string,
  patch: UpdateCompanyMemberInput,
): Promise<ICompany> {
  const company = await CourierCompany.findById(companyId);
  if (!company) {
    throw notFound('Company not found');
  }

  const target = company.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (!target) {
    throw notFound('Member not found');
  }

  // Only an owner may touch another owner.
  if (target.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may modify another owner');
  }

  // Demoting the last owner is rejected.
  if (
    patch.role !== undefined &&
    patch.role !== 'owner' &&
    target.role === 'owner' &&
    ownerCount(company) <= 1
  ) {
    throw conflict('Cannot demote the last owner of the company');
  }

  if (patch.role !== undefined) {
    // Only an owner may promote a member to owner.
    if (patch.role === 'owner' && actor.role !== 'owner') {
      throw forbidden('Only an owner may grant the owner role');
    }
    target.role = patch.role;
  }
  if (patch.permissions !== undefined) {
    target.permissions = [...patch.permissions];
  }

  await company.save();
  return company.toObject();
}

/**
 * Remove a member from a company. Enforces:
 *   - only an owner may remove another owner,
 *   - removing the last owner is rejected.
 */
export async function removeMember(
  companyId: string,
  actor: ICompanyMember,
  targetOxyUserId: string,
): Promise<ICompany> {
  const company = await CourierCompany.findById(companyId);
  if (!company) {
    throw notFound('Company not found');
  }

  const target = company.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (!target) {
    throw notFound('Member not found');
  }

  if (target.role === 'owner') {
    if (actor.role !== 'owner') {
      throw forbidden('Only an owner may remove another owner');
    }
    if (ownerCount(company) <= 1) {
      throw conflict('Cannot remove the last owner of the company');
    }
  }

  company.members = company.members.filter((m) => m.oxyUserId !== targetOxyUserId);
  await company.save();
  return company.toObject();
}

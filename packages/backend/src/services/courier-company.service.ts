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
// The full company-permission set, from the SAME `as const` tuple that renders
// `company_members_permissions_check`. The model exported its own copy; two
// copies of a closed set can disagree, and the one that matters is the one the
// database enforces.
import { COMPANY_PERMISSIONS as ALL_COMPANY_PERMISSIONS } from '../db/schema/valueSets.js';
import {
  companyHandleExists,
  deleteCompanyMember,
  findCompanyById,
  insertCompanyWithOwner,
  listCompaniesForMember,
  replaceCompanyServiceAreas,
  updateCompany as updateCompanyRow,
  upsertCompanyMember,
  type CompanyMemberValue,
  type CompanyServiceAreaValue,
  type CourierCompanyRecord,
} from '../db/fleet/courierCompanyRepository.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Default brand color for a company created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/** Count the owners currently on a company. */
function ownerCount(company: Pick<CourierCompanyRecord, 'members'>): number {
  return company.members.filter((m) => m.role === 'owner').length;
}

/** Map a service-area DTO to the persisted GeoJSON-center shape. */
function toServiceArea(area: NonNullable<CreateCompanyInput['serviceAreas']>[number]): CompanyServiceAreaValue {
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
): Promise<CourierCompanyRecord> {
  const handle = await ensureUniqueSlug(input.name, async (candidate) => {
    return companyHandleExists(candidate);
  });

  if (handle.length === 0) {
    throw validationError('Company name must contain at least one alphanumeric character');
  }

  // The company row and its owner member commit TOGETHER — see the repository.
  // The source got that atomicity for free by embedding `members` in the same
  // document; a company with no owner is one nobody can administer.
  const company = await insertCompanyWithOwner(
    {
      handle,
      name: input.name,
      description: input.description ?? '',
      brandColor: input.brandColor ?? DEFAULT_BRAND_COLOR,
      ...(input.logoFileId ? { logoFileId: input.logoFileId } : {}),
      ...(input.coverFileId ? { coverFileId: input.coverFileId } : {}),
      defaultCurrency: input.defaultCurrency ?? 'USD',
    },
    { oxyUserId: ownerOxyUserId, permissions: [...ALL_COMPANY_PERMISSIONS] },
  );

  const serviceAreas = (input.serviceAreas ?? []).map(toServiceArea);
  if (serviceAreas.length > 0) {
    await replaceCompanyServiceAreas(company.id, serviceAreas);
    return getCompany(company.id);
  }
  return company;
}

/** Fetch a company by id, or throw NOT_FOUND. */
export async function getCompany(companyId: string): Promise<CourierCompanyRecord> {
  const company = await findCompanyById(companyId);
  if (!company) {
    throw notFound('Company not found');
  }
  return company;
}

/** List the companies the given user is a member of. */
export async function listCompaniesForUser(oxyUserId: string): Promise<CourierCompanyRecord[]> {
  return listCompaniesForMember(oxyUserId);
}

/** Update a company's profile fields. Returns the updated company. */
export async function updateCompany(
  companyId: string,
  patch: UpdateCompanyInput,
): Promise<CourierCompanyRecord> {
  const existing = await findCompanyById(companyId);
  if (!existing) {
    throw notFound('Company not found');
  }

  if (patch.serviceAreas !== undefined) {
    await replaceCompanyServiceAreas(companyId, patch.serviceAreas.map(toServiceArea));
  }

  const updated = await updateCompanyRow(companyId, {
    name: patch.name,
    description: patch.description,
    brandColor: patch.brandColor,
    logoFileId: patch.logoFileId,
    coverFileId: patch.coverFileId,
    defaultCurrency: patch.defaultCurrency,
    textTone: patch.textTone,
    status: patch.status,
  });
  if (!updated) {
    throw notFound('Company not found');
  }
  return updated;
}

/**
 * Invite (add) a member to a company. The acting member's role gates whether
 * they may grant an `owner` role (only an existing owner may create another
 * owner). Rejects duplicates.
 */
export async function inviteMember(
  companyId: string,
  actor: CompanyMemberValue,
  input: InviteCompanyMemberInput,
): Promise<CourierCompanyRecord> {
  const company = await findCompanyById(companyId);
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

  await upsertCompanyMember(companyId, {
    oxyUserId: input.oxyUserId,
    role: input.role,
    permissions: input.permissions ?? [],
    joinedBy: actor.oxyUserId,
  });

  // Best-effort: notify the invited member. A notification failure must never
  // fail the invite itself.
  try {
    await sendNotification({
      userId: input.oxyUserId,
      type: 'company_member_invited',
      title: 'Company invitation',
      body: `You were added to ${company.name}`,
      data: { companyId: company.id, role: input.role },
    });
  } catch (err) {
    log.general.warn(
      { err, companyId: company.id },
      'company_member_invited notification failed',
    );
  }

  return getCompany(companyId);
}

/**
 * Update a member's role/permissions. Enforces:
 *   - only an owner may modify another owner,
 *   - demoting the last owner away from `owner` is rejected.
 */
export async function updateMember(
  companyId: string,
  actor: CompanyMemberValue,
  targetOxyUserId: string,
  patch: UpdateCompanyMemberInput,
): Promise<CourierCompanyRecord> {
  const company = await findCompanyById(companyId);
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
  }

  await upsertCompanyMember(companyId, {
    oxyUserId: targetOxyUserId,
    role: patch.role ?? target.role,
    permissions: patch.permissions === undefined ? target.permissions : [...patch.permissions],
  });
  return getCompany(companyId);
}

/**
 * Remove a member from a company. Enforces:
 *   - only an owner may remove another owner,
 *   - removing the last owner is rejected.
 */
export async function removeMember(
  companyId: string,
  actor: CompanyMemberValue,
  targetOxyUserId: string,
): Promise<CourierCompanyRecord> {
  const company = await findCompanyById(companyId);
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

  await deleteCompanyMember(companyId, targetOxyUserId);
  return getCompany(companyId);
}

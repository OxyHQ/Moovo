/**
 * Company members controller (THIN).
 *
 * Lists/invites/updates/removes company members. The acting member
 * (`req.companyMembership`, set by `loadCompany`) is passed to
 * `courier-company.service` so it can enforce the owner-protection invariants
 * (only an owner may touch another owner; the last owner cannot be
 * removed/demoted). Those rules live in the service, not here.
 */

import type { Request, Response } from 'express';
import type {
  InviteCompanyMemberInput,
  UpdateCompanyMemberInput,
  CompanyMember,
} from '@moovo/shared-types';
import type { ICompany, ICompanyMember } from '../../models/courier-company.js';
import {
  inviteMember,
  updateMember,
  removeMember,
} from '../../services/courier-company.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** Serialize a company member to the `CompanyMember` DTO. */
function toMemberDTO(member: ICompanyMember): CompanyMember {
  return {
    oxyUserId: member.oxyUserId,
    role: member.role,
    permissions: [...member.permissions],
    ...(member.joinedBy ? { joinedBy: member.joinedBy } : {}),
    joinedAt: member.joinedAt.toISOString(),
  };
}

/** Read the loaded company + acting membership, or respond 500 if missing. */
function loaded(req: Request, res: Response): { company: ICompany; actor: ICompanyMember } | null {
  const company = req.company;
  const actor = req.companyMembership;
  if (!company || !actor) {
    respondWithError(res, undefined, 'Company not loaded');
    return null;
  }
  return { company, actor };
}

/** GET /admin/companies/:companyId/members — list members. */
export function listMembers(req: Request, res: Response): void {
  const ctx = loaded(req, res);
  if (!ctx) return;
  sendSuccess(res, ctx.company.members.map(toMemberDTO));
}

/** POST /admin/companies/:companyId/members — invite/add a member. */
export async function addMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  try {
    const companyId = String((ctx.company as { _id: unknown })._id);
    const updated = await inviteMember(companyId, ctx.actor, req.body as InviteCompanyMemberInput);
    sendSuccess(res, updated.members.map(toMemberDTO), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to add company member');
    respondWithError(res, err, 'Failed to add member');
  }
}

/** PATCH /admin/companies/:companyId/members/:oxyUserId — update a member. */
export async function patchMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  const targetOxyUserId = routeParam(req, 'oxyUserId');
  try {
    const companyId = String((ctx.company as { _id: unknown })._id);
    const updated = await updateMember(
      companyId,
      ctx.actor,
      targetOxyUserId,
      req.body as UpdateCompanyMemberInput,
    );
    sendSuccess(res, updated.members.map(toMemberDTO));
  } catch (err) {
    log.general.error({ err, targetOxyUserId }, 'Failed to update company member');
    respondWithError(res, err, 'Failed to update member');
  }
}

/** DELETE /admin/companies/:companyId/members/:oxyUserId — remove a member. */
export async function deleteMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  const targetOxyUserId = routeParam(req, 'oxyUserId');
  try {
    const companyId = String((ctx.company as { _id: unknown })._id);
    const updated = await removeMember(companyId, ctx.actor, targetOxyUserId);
    sendSuccess(res, updated.members.map(toMemberDTO));
  } catch (err) {
    log.general.error({ err, targetOxyUserId }, 'Failed to remove company member');
    respondWithError(res, err, 'Failed to remove member');
  }
}

/**
 * Company authorization middleware.
 *
 * Composes AFTER `authenticateToken` (so `req.userId` is set) on every
 * `/admin/companies/:companyId/...` route:
 *   1. `loadCompany`              — resolve `:companyId`, attach `req.company` +
 *                                   `req.companyMembership`, 404/403 as appropriate.
 *   2. `requireCompanyRole(...)`  — gate on the member's ROLE.
 *   3. `requireCompanyPermission(perm)` — gate on the member's EFFECTIVE
 *                                   permission set (role defaults ∪ explicit grants).
 *
 * Owner-protection rules (cannot remove/demote the last owner; only an owner may
 * change/remove another owner) live in `courier-company.service`, NOT here.
 */

import type { Request, Response, NextFunction } from 'express';
import { isValidObjectId } from 'mongoose';
import type { CompanyRole, CompanyPermission } from '@moovo/shared-types';
import { CourierCompany, type ICompany, type ICompanyMember } from '../models/courier-company.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

// Extend Express Request with the loaded company context. The base augmentation
// (userId/user/…) lives in `auth.ts`; this only adds the company fields.
declare global {
  namespace Express {
    interface Request {
      company?: ICompany;
      companyMembership?: ICompanyMember;
    }
  }
}

/** The full set of permissions a company can grant. */
const ALL_PERMISSIONS: readonly CompanyPermission[] = [
  'company:manage',
  'members:manage',
  'fleet:write',
  'jobs:read',
  'jobs:dispatch',
  'stats:read',
];

/** Permissions a dispatcher holds — everything except company-level destructive ops. */
const DISPATCHER_PERMISSIONS: readonly CompanyPermission[] = ALL_PERMISSIONS.filter(
  (p) => p !== 'company:manage',
);

/** Permissions a driver holds by default. */
const DRIVER_PERMISSIONS: readonly CompanyPermission[] = ['jobs:read'];

/**
 * Default permission set granted by each role. A member's EFFECTIVE permissions
 * are these defaults UNIONed with their explicit `permissions[]` grants.
 *
 * - `owner`      — every permission (including `company:manage`).
 * - `dispatcher` — everything except `company:manage` (company delete / ownership transfer).
 * - `driver`     — `jobs:read` only.
 */
export const ROLE_PERMISSIONS: Record<CompanyRole, CompanyPermission[]> = {
  owner: [...ALL_PERMISSIONS],
  dispatcher: [...DISPATCHER_PERMISSIONS],
  driver: [...DRIVER_PERMISSIONS],
};

/** Compute a member's effective permissions: role defaults ∪ explicit grants. */
export function effectiveCompanyPermissions(member: ICompanyMember): Set<CompanyPermission> {
  const effective = new Set<CompanyPermission>(ROLE_PERMISSIONS[member.role]);
  for (const perm of member.permissions) {
    effective.add(perm);
  }
  return effective;
}

/**
 * Resolve `:companyId`, attach `req.company` + `req.companyMembership`. Responds:
 *   - 400 if the param is missing/malformed,
 *   - 401 if the caller is unauthenticated,
 *   - 404 if no company with that id exists,
 *   - 403 if the caller is authenticated but not a member of the company.
 *
 * MUST run after `authenticateToken` so `req.userId` is present.
 */
export async function loadCompany(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.params.companyId;
  const companyId = Array.isArray(raw) ? raw[0] : raw;

  if (!companyId || !isValidObjectId(companyId)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'Invalid companyId', 400);
    return;
  }

  const callerId = req.userId;
  if (!callerId) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  try {
    const company = await CourierCompany.findById(companyId);
    if (!company) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Company not found', 404);
      return;
    }

    const membership = company.members.find((m) => m.oxyUserId === callerId);
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'You are not a member of this company', 403);
      return;
    }

    req.company = company;
    req.companyMembership = membership;
    next();
  } catch (err) {
    log.general.error({ err, companyId }, 'Failed to load company for authorization');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load company', 500);
  }
}

/**
 * Gate a route on the caller holding one of `roles`. MUST run after
 * `loadCompany` (which attaches `req.companyMembership`).
 */
export function requireCompanyRole(...roles: CompanyRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const membership = req.companyMembership;
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Company membership required', 403);
      return;
    }
    if (!roles.includes(membership.role)) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Insufficient role for this action', 403);
      return;
    }
    next();
  };
}

/**
 * Gate a route on the caller's EFFECTIVE permission set (role defaults ∪
 * explicit grants) containing `perm`. MUST run after `loadCompany`.
 */
export function requireCompanyPermission(perm: CompanyPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const membership = req.companyMembership;
    if (!membership) {
      sendError(res, ErrorCodes.FORBIDDEN, 'Company membership required', 403);
      return;
    }
    if (!effectiveCompanyPermissions(membership).has(perm)) {
      sendError(res, ErrorCodes.FORBIDDEN, `Missing permission: ${perm}`, 403);
      return;
    }
    next();
  };
}

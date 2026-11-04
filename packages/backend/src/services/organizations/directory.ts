import { OxyApiError } from '@oxy.so/core';
import type { OxyCallerRequest } from '@oxy.so/core/server';
import type { CourierCompanyRecord } from '../../db/fleet/courierCompanyRepository.js';
import { oxyClient } from '../../middleware/auth.js';
import { forbidden, notFound, MoovoError } from '../../lib/errors/error-codes.js';

export type FleetCompany = CourierCompanyRecord & { name: string; logoFileId?: string };

/** Public identity hydration is globally deduplicated and bounded; never read local archived names. */
export async function hydrateCompanies(rows: CourierCompanyRecord[]): Promise<FleetCompany[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.oxyAccountId ? [row.oxyAccountId] : [])))];
  const organizations = new Map<string, Awaited<ReturnType<typeof oxyClient.organizations.get>>>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const result = await oxyClient.organizations
      .batch({ ids: ids.slice(offset, offset + 100) })
      .catch(() => {
        throw new MoovoError({
          code: 'INTERNAL_ERROR',
          httpStatus: 503,
          message: 'Organization directory is temporarily unavailable',
        });
      });
    for (const item of result.items) organizations.set(item.requestedAccountId, item.organization);
  }
  return rows.flatMap((row) => {
    const organization = organizations.get(row.oxyAccountId);
    if (!organization || organization.status === 'suppressed') return [];
    return [
      {
        ...row,
        oxyAccountId: organization.accountId,
        name: organization.name,
        ...(organization.avatar ? { logoFileId: organization.avatar } : {}),
      },
    ];
  });
}

/**
 * Registering a fleet needs a person who may administer the claimed Oxy
 * organization: Oxy answers with the caller's own verified session
 * (`accountAccessFor`, fresh — this precedes a write), gated on the
 * `account:update` permission rather than a role name, so a per-member revoke
 * is honoured. A refusal is 403, a gone session 401, and Oxy being unreachable
 * 503 (`respondWithError`), never a "no".
 */
export async function requireOrganizationAdministrator(
  caller: OxyCallerRequest,
  accountId: string,
) {
  const access = await oxyClient.accountAccessFor(caller, accountId, { fresh: true });
  if (access.kind !== 'organization' || !access.has('account:update'))
    throw forbidden('Only an Oxy organization administrator may register its fleet');
  const organization = await oxyClient.organizations.get(accountId).catch((error: unknown) => {
    if (error instanceof OxyApiError && error.status === 404)
      throw forbidden('Claim an active organization in Oxy before registering its fleet');
    throw new MoovoError({
      code: 'INTERNAL_ERROR',
      httpStatus: 503,
      message: 'Organization access is temporarily unavailable',
      cause: error,
    });
  });
  if (organization.status !== 'active' || organization.claimStatus !== 'claimed')
    throw forbidden('Claim an active organization in Oxy before registering its fleet');
  return organization;
}

export async function hydrateCompany(row: CourierCompanyRecord): Promise<FleetCompany> {
  const [company] = await hydrateCompanies([row]);
  if (!company) throw notFound('Organization unavailable');
  return company;
}

import { OxyApiError, OxyServices } from '@oxy.so/core';
import type { CourierCompanyRecord } from '../../db/fleet/courierCompanyRepository.js';
import { oxyClient } from '../../middleware/auth.js';
import {
  forbidden,
  notFound,
  unauthorized,
  MoovoError,
  isMoovoError,
} from '../../lib/errors/error-codes.js';

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

/** The original verified session is sent only to Oxy, using a disposable request-scoped client. */
export async function requireOrganizationAdministrator(
  accountId: string,
  accessToken: string | undefined,
) {
  if (!accessToken) throw unauthorized('An Oxy session is required');
  const client = new OxyServices({
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    enableCache: false,
    enableRetry: false,
    requestTimeout: 5000,
  });
  client.session.setAccessToken(accessToken);
  try {
    const node = await client.accounts.get(accountId);
    const membership = node.callerMembership;
    if (
      node.kind !== 'organization' ||
      !membership ||
      membership.status !== 'active' ||
      !['owner', 'admin'].includes(membership.role)
    )
      throw forbidden('Only an Oxy organization administrator may register its fleet');
    const organization = await client.organizations.get(accountId);
    if (organization.status !== 'active' || organization.claimStatus !== 'claimed')
      throw forbidden('Claim an active organization in Oxy before registering its fleet');
    return organization;
  } catch (error) {
    if (isMoovoError(error)) throw error;
    if (error instanceof OxyApiError && [403, 404].includes(error.status))
      throw forbidden('Organization administrator access is required');
    if (error instanceof OxyApiError && error.status === 401)
      throw unauthorized('Your Oxy session is no longer valid');
    throw new MoovoError({
      code: 'INTERNAL_ERROR',
      httpStatus: 503,
      message: 'Organization access is temporarily unavailable',
    });
  } finally {
    client.dispose();
  }
}

export async function hydrateCompany(row: CourierCompanyRecord): Promise<FleetCompany> {
  const [company] = await hydrateCompanies([row]);
  if (!company) throw notFound('Organization unavailable');
  return company;
}

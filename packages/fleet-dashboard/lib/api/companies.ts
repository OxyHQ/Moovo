import type { Company, ApiResponse } from '@moovo/shared-types';
import apiClient from './client';

/**
 * Companies API client (fleet admin).
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend
 * and backend agree on the `Company` shape. This is the seam the Moovo Hub
 * fleet dashboard (the operator's companies, members and jobs) is built on.
 */

/**
 * Fetch the companies the current operator can administer.
 *
 * Bearer-authenticated via the shared `apiClient` token interceptor; the API
 * scopes the result to the authenticated Oxy user's company memberships.
 */
export async function fetchCompanies(): Promise<ApiResponse<Company[]>> {
  const { data } = await apiClient.get<ApiResponse<Company[]>>('/admin/companies');
  return data;
}

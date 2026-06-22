import type {
  Company,
  CreateCompanyInput,
  UpdateCompanyInput,
  ApiResponse,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Companies API client (fleet admin).
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the `Company` shape. Bearer-authenticated via the shared
 * `apiClient` token interceptor; the API scopes results to the authenticated
 * Oxy user's company memberships and gates writes by the caller's role.
 *
 * Mount prefix (verified in `routes/admin/index.ts`): `/admin/companies`.
 */

/** Unwrap an `ApiResponse<T>` payload or throw the API's error message. */
function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.message ?? res.error ?? "Request failed");
  }
  return res.data;
}

/** `GET /admin/companies` — the companies the operator can administer. */
export async function fetchCompanies(): Promise<Company[]> {
  const { data } = await apiClient.get<ApiResponse<Company[]>>(
    "/admin/companies",
  );
  return unwrap(data);
}

/** `GET /admin/companies/:companyId` — a single company the caller is a member of. */
export async function fetchCompany(companyId: string): Promise<Company> {
  const { data } = await apiClient.get<ApiResponse<Company>>(
    `/admin/companies/${companyId}`,
  );
  return unwrap(data);
}

/** `POST /admin/companies` — create a company; the caller becomes its owner. */
export async function createCompany(
  input: CreateCompanyInput,
): Promise<Company> {
  const { data } = await apiClient.post<ApiResponse<Company>>(
    "/admin/companies",
    input,
  );
  return unwrap(data);
}

/** `PATCH /admin/companies/:companyId` — update a company (needs `company:manage`). */
export async function updateCompany(
  companyId: string,
  input: UpdateCompanyInput,
): Promise<Company> {
  const { data } = await apiClient.patch<ApiResponse<Company>>(
    `/admin/companies/${companyId}`,
    input,
  );
  return unwrap(data);
}

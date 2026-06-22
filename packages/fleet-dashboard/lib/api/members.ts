import type {
  CompanyMember,
  InviteCompanyMemberInput,
  UpdateCompanyMemberInput,
  ApiResponse,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Company members API client.
 *
 * Mount prefix (verified in `routes/admin/company-members.ts`):
 * `/admin/companies/:companyId/members`. Every route requires the caller's
 * `members:manage` permission; the owner-protection invariants (last owner
 * cannot be removed/demoted; only an owner may touch another owner) are enforced
 * server-side and surfaced as 4xx errors.
 *
 * The invite/patch/delete handlers all return the company's FULL updated member
 * list, so the cache is replaced wholesale on each mutation.
 */

/** Unwrap an `ApiResponse<T>` payload or throw the API's error message. */
function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.message ?? res.error ?? "Request failed");
  }
  return res.data;
}

/** `GET /admin/companies/:companyId/members` — list the company's members. */
export async function fetchMembers(
  companyId: string,
): Promise<CompanyMember[]> {
  const { data } = await apiClient.get<ApiResponse<CompanyMember[]>>(
    `/admin/companies/${companyId}/members`,
  );
  return unwrap(data);
}

/** `POST /admin/companies/:companyId/members` — invite/add a member. */
export async function inviteMember(
  companyId: string,
  input: InviteCompanyMemberInput,
): Promise<CompanyMember[]> {
  const { data } = await apiClient.post<ApiResponse<CompanyMember[]>>(
    `/admin/companies/${companyId}/members`,
    input,
  );
  return unwrap(data);
}

/** `PATCH /admin/companies/:companyId/members/:oxyUserId` — change role/permissions. */
export async function updateMember(
  companyId: string,
  oxyUserId: string,
  input: UpdateCompanyMemberInput,
): Promise<CompanyMember[]> {
  const { data } = await apiClient.patch<ApiResponse<CompanyMember[]>>(
    `/admin/companies/${companyId}/members/${oxyUserId}`,
    input,
  );
  return unwrap(data);
}

/** `DELETE /admin/companies/:companyId/members/:oxyUserId` — remove a member. */
export async function removeMember(
  companyId: string,
  oxyUserId: string,
): Promise<CompanyMember[]> {
  const { data } = await apiClient.delete<ApiResponse<CompanyMember[]>>(
    `/admin/companies/${companyId}/members/${oxyUserId}`,
  );
  return unwrap(data);
}

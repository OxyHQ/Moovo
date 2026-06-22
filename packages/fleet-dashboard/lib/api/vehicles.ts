import type {
  Vehicle,
  CreateVehicleInput,
  ApiResponse,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Company vehicles (fleet) API client.
 *
 * Mount prefix (verified in `routes/admin/company-vehicles.ts`):
 * `/admin/companies/:companyId/vehicles`. Reads require `jobs:read` (any member
 * may see the fleet); writes require `fleet:write`.
 */

/** Unwrap an `ApiResponse<T>` payload or throw the API's error message. */
function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.message ?? res.error ?? "Request failed");
  }
  return res.data;
}

/**
 * Partial vehicle update body, mirroring the backend `updateVehicleSchema`:
 * any subset of the create fields plus the lifecycle `status`.
 */
export type UpdateVehicleBody = Partial<CreateVehicleInput> & {
  status?: Vehicle["status"];
};

/** `GET /admin/companies/:companyId/vehicles` — the company's vehicles. */
export async function fetchVehicles(companyId: string): Promise<Vehicle[]> {
  const { data } = await apiClient.get<ApiResponse<Vehicle[]>>(
    `/admin/companies/${companyId}/vehicles`,
  );
  return unwrap(data);
}

/** `POST /admin/companies/:companyId/vehicles` — add a company vehicle. */
export async function createVehicle(
  companyId: string,
  input: CreateVehicleInput,
): Promise<Vehicle> {
  const { data } = await apiClient.post<ApiResponse<Vehicle>>(
    `/admin/companies/${companyId}/vehicles`,
    input,
  );
  return unwrap(data);
}

/** `PATCH /admin/companies/:companyId/vehicles/:id` — update a company vehicle. */
export async function updateVehicle(
  companyId: string,
  vehicleId: string,
  input: UpdateVehicleBody,
): Promise<Vehicle> {
  const { data } = await apiClient.patch<ApiResponse<Vehicle>>(
    `/admin/companies/${companyId}/vehicles/${vehicleId}`,
    input,
  );
  return unwrap(data);
}

/** `DELETE /admin/companies/:companyId/vehicles/:id` — remove a company vehicle. */
export async function deleteVehicle(
  companyId: string,
  vehicleId: string,
): Promise<{ id: string }> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string }>>(
    `/admin/companies/${companyId}/vehicles/${vehicleId}`,
  );
  return unwrap(data);
}

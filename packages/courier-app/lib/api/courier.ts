import type {
  ApiResponse,
  CourierProfile,
  CreateVehicleInput,
  Vehicle,
  VehicleType,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Courier API client.
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the courier-profile and vehicle shapes. These are the
 * private, bearer-authenticated endpoints the courier "on the road" surface is
 * built on: the signed-in courier reads their own aggregate profile, flips their
 * real-time availability, manages their vehicles, selects the active one, and
 * pings their location.
 */

/** Fetch the signed-in courier's own profile (aggregates + availability). */
export async function fetchCourierMe(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.get<ApiResponse<CourierProfile>>("/courier/me");
  return data;
}

/** Flip the signed-in courier to `online` so they can be offered jobs. */
export async function goOnline(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>("/courier/online");
  return data;
}

/** Flip the signed-in courier to `offline` so they stop being offered jobs. */
export async function goOffline(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>("/courier/offline");
  return data;
}

/** Record a courier location ping (the profile-scoped GPS heartbeat). */
export async function pingCourierLocation(
  lng: number,
  lat: number,
): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>(
    "/courier/location",
    { lng, lat },
  );
  return data;
}

/** List the signed-in courier's vehicles. */
export async function fetchCourierVehicles(): Promise<ApiResponse<Vehicle[]>> {
  const { data } = await apiClient.get<ApiResponse<Vehicle[]>>("/courier/vehicles");
  return data;
}

/** Create a vehicle for the signed-in courier. */
export async function createCourierVehicle(
  input: CreateVehicleInput,
): Promise<ApiResponse<Vehicle>> {
  const { data } = await apiClient.post<ApiResponse<Vehicle>>(
    "/courier/vehicles",
    input,
  );
  return data;
}

/** Editable fields of a courier vehicle. */
export interface UpdateCourierVehicleInput {
  /** Vehicle category. */
  type?: VehicleType;
  /** Optional human label (e.g. "Red Vespa"). */
  label?: string;
  /** Optional registration plate. */
  plate?: string;
  /** Optional capacity overrides; weight defaults from the capability table. */
  capacity?: CreateVehicleInput["capacity"];
  /** Lifecycle status. */
  status?: "active" | "inactive";
}

/** Update one of the signed-in courier's vehicles. */
export async function updateCourierVehicle(
  id: string,
  input: UpdateCourierVehicleInput,
): Promise<ApiResponse<Vehicle>> {
  const { data } = await apiClient.patch<ApiResponse<Vehicle>>(
    `/courier/vehicles/${id}`,
    input,
  );
  return data;
}

/** Delete one of the signed-in courier's vehicles. */
export async function deleteCourierVehicle(
  id: string,
): Promise<ApiResponse<{ id: string }>> {
  const { data } = await apiClient.delete<ApiResponse<{ id: string }>>(
    `/courier/vehicles/${id}`,
  );
  return data;
}

/** Select the signed-in courier's active vehicle (recomputes their capability). */
export async function setActiveVehicle(
  vehicleId: string,
): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>(
    "/courier/active-vehicle",
    { vehicleId },
  );
  return data;
}

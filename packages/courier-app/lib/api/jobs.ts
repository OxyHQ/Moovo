import type {
  ApiResponse,
  JobStatus,
  JobSummary,
  JobView,
  PaginatedResponse,
  ScanInput,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Jobs API client.
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the job shapes. `GET /jobs` is role-scoped: passing
 * `role: 'courier'` returns the jobs assigned to the signed-in courier (their
 * dashboard list). The lifecycle actions (accept, scan, pickup, in-transit,
 * deliver, location ping) drive a job from offered through delivered; each
 * returns the freshly-hydrated `JobView`.
 */

/** Optional filters/pagination accepted by the courier job list. */
export interface FetchCourierJobsParams {
  /** Restrict to a single lifecycle status. */
  status?: JobStatus;
  /** 1-based page index (defaults to 1 server-side). */
  page?: number;
  /** Page size (server clamps to a sane maximum). */
  limit?: number;
}

/** Fetch the signed-in courier's assigned jobs (their dashboard list). */
export async function fetchCourierJobs(
  params: FetchCourierJobsParams = {},
): Promise<PaginatedResponse<JobSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<JobSummary>>("/jobs", {
    params: { role: "courier", ...params },
  });
  return data;
}

/** Fetch a single job visible to the signed-in courier. */
export async function fetchJob(id: string): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.get<ApiResponse<JobView>>(`/jobs/${id}`);
  return data;
}

/**
 * Accept an offered job. Offer-gated and atomic server-side — a 409 CONFLICT
 * means another courier won the offer race first.
 */
export async function acceptJob(id: string): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(`/jobs/${id}/accept`);
  return data;
}

/**
 * Scan the pickup/dropoff QR code to prove a leg. The backend verifies the
 * scanned `code` against the job's stored hash and advances the status
 * (`accepted → picked_up` for `pickup`, `in_transit → delivered` for `dropoff`).
 */
export async function scanJob(
  id: string,
  input: ScanInput,
): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(
    `/jobs/${id}/scan`,
    input,
  );
  return data;
}

/** An optional lng/lat attached to a job lifecycle transition. */
export interface JobTransitionLocation {
  /** Longitude, when a GPS fix is available. */
  lng?: number;
  /** Latitude, when a GPS fix is available. */
  lat?: number;
}

/** Mark the assigned job picked up (`accepted → picked_up`). */
export async function pickupJob(
  id: string,
  location: JobTransitionLocation = {},
): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(
    `/jobs/${id}/pickup`,
    location,
  );
  return data;
}

/** Start delivery (`picked_up → in_transit`). */
export async function startTransit(
  id: string,
  location: JobTransitionLocation = {},
): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(
    `/jobs/${id}/in-transit`,
    location,
  );
  return data;
}

/** Record a courier location ping against the active job. */
export async function pingJobLocation(
  id: string,
  lng: number,
  lat: number,
): Promise<ApiResponse<JobView>> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(
    `/jobs/${id}/location`,
    { lng, lat },
  );
  return data;
}

import type {
  JobSummary,
  JobView,
  JobStatus,
  PaginatedResponse,
  ApiResponse,
} from "@moovo/shared-types";
import apiClient from "./client";

/**
 * Jobs API client (the operator's own jobs).
 *
 * Verified contract (`routes/jobs.ts` → `job.controller.ts`):
 * - `GET /jobs` is scoped to the CALLER as a `sender` (default) OR, with
 *   `?role=courier`, as the assigned courier. It is NOT company-scoped — there
 *   is no `?companyId` filter or company-jobs route in the backend today. The
 *   dispatch board therefore shows the OPERATOR's own jobs and explicitly flags
 *   the missing company-wide feed (see `dispatch.tsx`). When the backend adds a
 *   company-scoped jobs endpoint, only this module + the dispatch query change.
 * - `GET /jobs` returns the bare `PaginatedResponse<JobSummary>` envelope
 *   (`{ data, pagination }`), NOT an `ApiResponse` wrapper.
 * - `GET /jobs/:id` returns an `ApiResponse<JobView>`.
 */

/** Unwrap an `ApiResponse<T>` payload or throw the API's error message. */
function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.message ?? res.error ?? "Request failed");
  }
  return res.data;
}

/** Query parameters accepted by the jobs list endpoint. */
export interface JobsQuery {
  role?: "sender" | "courier";
  status?: JobStatus;
  page?: number;
  limit?: number;
}

/** `GET /jobs` — the operator's jobs (role-scoped), paginated. */
export async function fetchJobs(
  query: JobsQuery = {},
): Promise<PaginatedResponse<JobSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<JobSummary>>("/jobs", {
    params: {
      role: query.role ?? "sender",
      ...(query.status ? { status: query.status } : {}),
      ...(query.page ? { page: query.page } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    },
  });
  return data;
}

/** `GET /jobs/:id` — a single job visible to the caller (sender or courier). */
export async function fetchJob(jobId: string): Promise<JobView> {
  const { data } = await apiClient.get<ApiResponse<JobView>>(`/jobs/${jobId}`);
  return unwrap(data);
}

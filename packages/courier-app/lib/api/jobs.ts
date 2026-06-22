import type {
  JobStatus,
  JobSummary,
  PaginatedResponse,
} from '@moovo/shared-types';
import apiClient from './client';

/**
 * Jobs API client.
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the job-list shape. `GET /jobs` is role-scoped: passing
 * `role: 'courier'` returns the jobs assigned to the signed-in courier (their
 * dashboard list), as opposed to the sender's own bookings.
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
  const { data } = await apiClient.get<PaginatedResponse<JobSummary>>('/jobs', {
    params: { role: 'courier', ...params },
  });
  return data;
}

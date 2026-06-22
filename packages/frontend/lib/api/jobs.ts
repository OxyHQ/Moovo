import type {
  JobView,
  JobSummary,
  JobStatus,
  ApiResponse,
  PaginatedResponse,
  PaginationParams,
} from '@moovo/shared-types';
import apiClient from './client';

/**
 * Jobs API client — the booked-job lifecycle as seen by the SENDER (customer).
 *
 * The customer app only ever reads jobs as the sender (the courier lifecycle
 * actions live in Moovo Go). `GET /jobs/:id` returns the owner-scoped `JobView`,
 * which for the sender includes the plaintext pickup/dropoff codes to render as
 * QR. `cancelJob` is allowed where the service permits it (pre-pickup).
 */

/** Unwrap an `ApiResponse<T>` envelope, throwing the message on a failed/empty body. */
function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.message ?? body.error ?? 'Request failed');
  }
  return body.data;
}

/** Query parameters for the sender's job list. */
export interface JobQuery extends PaginationParams {
  /** Optional status filter. */
  status?: JobStatus;
}

/** List the caller's jobs as the SENDER (compact summaries, paginated). */
export async function fetchMyJobs(query: JobQuery = {}): Promise<PaginatedResponse<JobSummary>> {
  const { data } = await apiClient.get<PaginatedResponse<JobSummary>>('/jobs', {
    // The customer app is always the sender; the backend defaults `role` to
    // `sender` so we do not pass it.
    params: query,
  });
  return data;
}

/** Fetch a single job visible to the caller; owner-scoped (includes QR codes). */
export async function fetchJob(id: string): Promise<JobView> {
  const { data } = await apiClient.get<ApiResponse<JobView>>(`/jobs/${id}`);
  return unwrap(data);
}

/** Cancel a job the caller is party to (allowed pre-pickup; enforced server-side). */
export async function cancelJob(id: string): Promise<JobView> {
  const { data } = await apiClient.post<ApiResponse<JobView>>(`/jobs/${id}/cancel`, {});
  return unwrap(data);
}

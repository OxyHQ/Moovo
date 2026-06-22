import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { JobView, JobSummary, PaginatedResponse } from '@moovo/shared-types';
import { fetchMyJobs, fetchJob, cancelJob, type JobQuery } from '@/lib/api/jobs';
import { queryKeys } from '@/lib/hooks/query-keys';

/**
 * TanStack Query hooks for the sender's booked jobs.
 *
 * Reads gate on `isAuthenticated`. The tracking screen's `useJob` is the
 * authoritative source the socket hook invalidates on every lifecycle event, so
 * status/timeline/courier info refetch automatically without local state.
 */

/** List the caller's jobs as the sender (paginated summaries). */
export function useMyJobs(query: JobQuery = {}) {
  const { isAuthenticated } = useOxy();
  return useQuery<PaginatedResponse<JobSummary>>({
    queryKey: queryKeys.jobs.list(query),
    queryFn: () => fetchMyJobs(query),
    enabled: isAuthenticated,
  });
}

/** Fetch a single job (owner-scoped `JobView`, includes QR codes for the sender). */
export function useJob(id: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<JobView>({
    queryKey: queryKeys.jobs.detail(id ?? ''),
    queryFn: () => fetchJob(id ?? ''),
    enabled: isAuthenticated && Boolean(id),
  });
}

/** Cancel a job (allowed pre-pickup; enforced server-side). */
export function useCancelJob(id: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<JobView, Error, void>({
    mutationFn: () => cancelJob(id ?? ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      if (id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(id) });
      }
    },
  });
}

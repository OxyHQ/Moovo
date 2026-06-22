import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { GeoPoint, JobStatus } from '@moovo/shared-types';
import { getSocket } from '@/lib/socket';
import { queryKeys } from '@/lib/hooks/query-keys';

/**
 * Socket.IO event names for the Moovo transport domain.
 *
 * These MUST stay in lockstep with the backend registry
 * (`packages/backend/src/lib/socket-events.ts`). The backend lives in a separate
 * package whose event names are not published to `@moovo/shared-types`, so the
 * literals are mirrored here as the one client-side source of truth.
 */
const JOB_EVENTS = {
  ACCEPTED: 'job:accepted',
  LOCATION: 'job:location',
  PICKED_UP: 'job:picked_up',
  IN_TRANSIT: 'job:in_transit',
  DELIVERED: 'job:delivered',
  CANCELLED: 'job:cancelled',
} as const;

/** Payload of a `job:location` ping (matches `emitJobLocation` on the server). */
interface JobLocationPayload {
  jobId: string;
  location: GeoPoint;
  at: string;
}

/** Payload of a job lifecycle event (matches `emitJobStatus` on the server). */
interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  jobNumber: string;
}

/** A live courier position observed over the socket for the tracked job. */
export interface LiveCourierPosition {
  /** `[lng, lat]` per GeoJSON. */
  coordinates: [number, number];
  /** ISO-8601 time of the ping. */
  at: string;
}

/**
 * Subscribe to a single job's realtime stream as the sender.
 *
 * Returns the latest live courier position (from `job:location` pings). On any
 * lifecycle transition (accepted/picked_up/in_transit/delivered/cancelled) it
 * invalidates the job's detail query so the screen refetches the authoritative
 * `JobView` (status timeline, courier info, codes). Subscriptions are scoped to
 * the given `jobId` and cleaned up on unmount or when the job/token changes.
 *
 * Socket subscription is a legitimate `useEffect` use (an external event source
 * with required teardown), not a data-fetching effect.
 */
export function useJobSocket(jobId: string | undefined): LiveCourierPosition | null {
  const { oxyServices, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const [courierPosition, setCourierPosition] = useState<LiveCourierPosition | null>(null);

  useEffect(() => {
    if (!jobId || !isAuthenticated) {
      return;
    }

    const token = oxyServices.getAccessToken();
    const socket = getSocket(token);
    if (!socket) {
      return;
    }

    const handleLocation = (payload: JobLocationPayload) => {
      if (payload.jobId !== jobId) {
        return;
      }
      setCourierPosition({ coordinates: payload.location.coordinates, at: payload.at });
    };

    const handleLifecycle = (payload: JobStatusPayload) => {
      if (payload.jobId !== jobId) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(jobId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    };

    socket.on(JOB_EVENTS.LOCATION, handleLocation);
    socket.on(JOB_EVENTS.ACCEPTED, handleLifecycle);
    socket.on(JOB_EVENTS.PICKED_UP, handleLifecycle);
    socket.on(JOB_EVENTS.IN_TRANSIT, handleLifecycle);
    socket.on(JOB_EVENTS.DELIVERED, handleLifecycle);
    socket.on(JOB_EVENTS.CANCELLED, handleLifecycle);

    return () => {
      socket.off(JOB_EVENTS.LOCATION, handleLocation);
      socket.off(JOB_EVENTS.ACCEPTED, handleLifecycle);
      socket.off(JOB_EVENTS.PICKED_UP, handleLifecycle);
      socket.off(JOB_EVENTS.IN_TRANSIT, handleLifecycle);
      socket.off(JOB_EVENTS.DELIVERED, handleLifecycle);
      socket.off(JOB_EVENTS.CANCELLED, handleLifecycle);
    };
  }, [jobId, isAuthenticated, oxyServices, queryClient]);

  return courierPosition;
}

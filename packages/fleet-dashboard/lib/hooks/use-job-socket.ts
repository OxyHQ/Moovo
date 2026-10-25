import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { GeoPoint } from '@moovo/shared-types';
import { openMoovoSocket, type JobStatusPayload, type JobLocationPayload } from '@/lib/socket';
import { queryKeys } from '@/lib/hooks/query-keys';

/** A job's most-recent live courier position, keyed by job id. */
export interface LiveJobLocation {
  jobId: string;
  location: GeoPoint;
  at: string;
}

/** What the dashboard exposes from the realtime job socket. */
export interface JobSocketState {
  /** Whether the socket is currently connected. */
  connected: boolean;
  /** Live courier positions keyed by job id (latest `job:location` per job). */
  liveLocations: Record<string, LiveJobLocation>;
  /** The most recent lifecycle transition received, for transient UI cues. */
  lastTransition: JobStatusPayload | null;
}

/**
 * Subscribe to the operator's realtime job stream.
 *
 * A Socket.IO subscription is a genuine side effect with cleanup, so `useEffect`
 * is the correct tool here (per the project rule, only DATA fetching avoids
 * effects). The socket auto-joins the operator's `user:<id>` room server-side, so
 * it receives lifecycle + location events for jobs the operator is party to
 * (sender or assigned courier). Lifecycle transitions invalidate the jobs cache
 * so the board refetches; location pings update an in-memory position map.
 *
 * `enabled` lets a screen defer the connection until it is actually showing the
 * live board (e.g. once a company is selected and the private API is ready).
 */
export function useJobSocket(enabled: boolean): JobSocketState {
  const { oxyServices, hasAccessToken } = useOxy();
  const queryClient = useQueryClient();
  const sessionEpoch = oxyServices.http.getSessionEpoch();
  const [stateEpoch, setStateEpoch] = useState(sessionEpoch);

  const [connected, setConnected] = useState(false);
  const [liveLocations, setLiveLocations] = useState<Record<string, LiveJobLocation>>({});
  const [lastTransition, setLastTransition] = useState<JobStatusPayload | null>(null);

  useEffect(() => {
    setLiveLocations({});
    setLastTransition(null);
    setConnected(false);
    setStateEpoch(sessionEpoch);
    if (!enabled || !hasAccessToken) {
      setConnected(false);
      return;
    }

    const connection = openMoovoSocket(oxyServices);
    const { socket } = connection;

    socket.on('connect', () => {
      if (connection.isCurrent()) setConnected(true);
    });
    socket.on('disconnect', () => setConnected(false));

    const onLocation = (payload: JobLocationPayload) => {
      if (!connection.isCurrent()) return;
      setLiveLocations((prev) => ({
        ...prev,
        [payload.jobId]: {
          jobId: payload.jobId,
          location: payload.location,
          at: payload.at,
        },
      }));
    };

    const onTransition = (payload: JobStatusPayload) => {
      if (!connection.isCurrent()) return;
      setLastTransition(payload);
      // A lifecycle change can affect either role-scoped list; invalidate both.
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    };

    socket.on('job:location', onLocation);
    socket.on('job:accepted', onTransition);
    socket.on('job:picked_up', onTransition);
    socket.on('job:in_transit', onTransition);
    socket.on('job:delivered', onTransition);
    socket.on('job:cancelled', onTransition);

    connection.connect();
    return () => {
      socket.off('job:location', onLocation);
      connection.dispose();
      setConnected(false);
    };
  }, [enabled, hasAccessToken, oxyServices, queryClient, sessionEpoch]);

  const current = hasAccessToken && enabled && stateEpoch === sessionEpoch;
  return {
    connected: current && connected,
    liveLocations: current ? liveLocations : {},
    lastTransition: current ? lastTransition : null,
  };
}

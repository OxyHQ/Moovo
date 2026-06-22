import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import type { JobOfferView, JobView } from "@moovo/shared-types";
import { connectSocket } from "@/lib/socket";
import { queryKeys } from "@/lib/hooks/query-keys";
import type { JobLocationEvent } from "@/lib/api/types";

/**
 * Backend Socket.IO event names (mirrors `packages/backend/src/lib/socket-events.ts`).
 * Kept as a const map so no raw event strings are scattered across the hook.
 */
const EVENTS = {
  JOB_OFFER: "job:offer",
  JOB_OFFER_TAKEN: "job:offer_taken",
  JOB_ACCEPTED: "job:accepted",
  JOB_LOCATION: "job:location",
  JOB_PICKED_UP: "job:picked_up",
  JOB_IN_TRANSIT: "job:in_transit",
  JOB_DELIVERED: "job:delivered",
  JOB_CANCELLED: "job:cancelled",
} as const;

/** Payload shape the backend sends with `job:offer_taken` (the superseded offer). */
interface OfferTakenEvent {
  offerId?: string;
  jobId?: string;
}

/** What {@link useJobSocket} exposes to a screen. */
export interface JobSocketState {
  /** The live incoming offer, or `null` when none is pending. */
  offer: JobOfferView | null;
  /** Dismiss the current offer (after accept/decline or when it's taken/expired). */
  clearOffer: () => void;
  /** Last courier location ping received over the wire, or `null`. */
  lastLocation: JobLocationEvent | null;
  /** Whether the socket is currently connected. */
  connected: boolean;
}

/**
 * Subscribe the signed-in courier to their real-time job stream.
 *
 * Opens (or reuses) the shared authenticated socket and wires the dispatch +
 * lifecycle events: an incoming `job:offer` becomes the live `offer` (an
 * `job:offer_taken` for the same job clears it); every lifecycle transition
 * invalidates the courier job list and any open job-detail query so the UI
 * re-fetches the authoritative state. The socket effect is a legitimate
 * subscription with full listener cleanup on unmount / token change.
 */
export function useJobSocket(): JobSocketState {
  const { oxyServices, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();

  const [offer, setOffer] = useState<JobOfferView | null>(null);
  const [lastLocation, setLastLocation] = useState<JobLocationEvent | null>(null);
  const [connected, setConnected] = useState(false);

  // Hold the latest offer in a ref so the offer_taken handler can compare without
  // re-subscribing every time the offer state changes.
  const offerRef = useRef<JobOfferView | null>(null);
  offerRef.current = offer;

  const token = isAuthenticated ? oxyServices.getAccessToken() : null;

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }

    const socket = connectSocket(token);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const invalidateJobs = (jobId?: string) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.courier });
      if (jobId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(jobId) });
      }
    };

    const onOffer = (incoming: JobOfferView) => setOffer(incoming);

    const onOfferTaken = (taken: OfferTakenEvent) => {
      const current = offerRef.current;
      if (current && (taken.jobId === current.jobId || taken.offerId === current.offerId)) {
        setOffer(null);
      }
    };

    const onAccepted = (job: JobView) => invalidateJobs(job.id);
    const onPickedUp = (job: JobView) => invalidateJobs(job.id);
    const onInTransit = (job: JobView) => invalidateJobs(job.id);
    const onDelivered = (job: JobView) => invalidateJobs(job.id);
    const onCancelled = (job: JobView) => invalidateJobs(job.id);

    const onLocation = (event: JobLocationEvent) => {
      setLastLocation(event);
      invalidateJobs(event.jobId);
    };

    setConnected(socket.connected);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on(EVENTS.JOB_OFFER, onOffer);
    socket.on(EVENTS.JOB_OFFER_TAKEN, onOfferTaken);
    socket.on(EVENTS.JOB_ACCEPTED, onAccepted);
    socket.on(EVENTS.JOB_PICKED_UP, onPickedUp);
    socket.on(EVENTS.JOB_IN_TRANSIT, onInTransit);
    socket.on(EVENTS.JOB_DELIVERED, onDelivered);
    socket.on(EVENTS.JOB_CANCELLED, onCancelled);
    socket.on(EVENTS.JOB_LOCATION, onLocation);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off(EVENTS.JOB_OFFER, onOffer);
      socket.off(EVENTS.JOB_OFFER_TAKEN, onOfferTaken);
      socket.off(EVENTS.JOB_ACCEPTED, onAccepted);
      socket.off(EVENTS.JOB_PICKED_UP, onPickedUp);
      socket.off(EVENTS.JOB_IN_TRANSIT, onInTransit);
      socket.off(EVENTS.JOB_DELIVERED, onDelivered);
      socket.off(EVENTS.JOB_CANCELLED, onCancelled);
      socket.off(EVENTS.JOB_LOCATION, onLocation);
    };
  }, [token, queryClient]);

  // Stable so consumers can safely list it in effect deps (e.g. the offer
  // countdown timer) without re-subscribing every render.
  const clearOffer = useCallback(() => setOffer(null), []);

  return { offer, clearOffer, lastLocation, connected };
}

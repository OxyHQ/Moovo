import { io, type Socket } from "socket.io-client";
import type { GeoPoint, JobStatus, JobOfferView } from "@moovo/shared-types";
import { SOCKET_URL } from "@/lib/config";

/**
 * Moovo Hub Socket.IO client.
 *
 * Connects to the Moovo backend (`SOCKET_URL`) and authenticates with the Oxy
 * access token via the `handshake.auth.token` callback form (verified in
 * `backend/src/socket.ts`: `io.use(authSocket())` auto-joins the SERVER-VERIFIED
 * `user:<id>` room). The token callback runs on every (re)connect so a refreshed
 * token is always sent.
 *
 * Event payloads mirror the backend emit sites EXACTLY
 * (`services/job-events.service.ts`, `services/dispatch.service.ts`).
 */

/** Payload for the job lifecycle transition events (accepted → cancelled). */
export interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  jobNumber: string;
}

/** Payload for the live courier-location event (`job:location`). */
export interface JobLocationPayload {
  jobId: string;
  location: GeoPoint;
  at: string;
}

/** The server→client events this dashboard listens for, with their payloads. */
export interface JobServerToClientEvents {
  "job:offer": (offer: JobOfferView) => void;
  "job:offer_taken": (payload: { jobId: string; offerId: string }) => void;
  "job:accepted": (payload: JobStatusPayload) => void;
  "job:picked_up": (payload: JobStatusPayload) => void;
  "job:in_transit": (payload: JobStatusPayload) => void;
  "job:delivered": (payload: JobStatusPayload) => void;
  "job:cancelled": (payload: JobStatusPayload) => void;
  "job:location": (payload: JobLocationPayload) => void;
}

/** A typed Moovo Socket.IO client (server→client events; no client→server emits). */
export type MoovoSocket = Socket<JobServerToClientEvents>;

/**
 * Open an authenticated Moovo socket. The caller owns the lifecycle and MUST
 * `disconnect()` it (the `useJobSocket` hook does this on unmount). The token is
 * read lazily on each (re)connect via `getToken` so refreshed tokens are used.
 */
export function connectMoovoSocket(getToken: () => string | null): MoovoSocket {
  return io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    // Callback form so every (re)connect sends a FRESH token; the server
    // verifies it and auto-joins the user's room.
    auth: (cb) => cb({ token: getToken() ?? "" }),
  });
}

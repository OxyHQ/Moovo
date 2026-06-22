import { io, type Socket } from 'socket.io-client';
import config from './config';

/**
 * Socket.IO client for the Moovo transport realtime channel.
 *
 * The server (`packages/backend/src/socket.ts`) authenticates EVERY connection
 * from `handshake.auth.token` (the Oxy access token) and auto-joins the verified
 * `user:<oxyUserId>` room — clients cannot name their own room. We therefore only
 * supply the bearer token; the room and event delivery are entirely server-side.
 *
 * A single shared connection is reused across hooks (a delivery-tracking screen
 * and any background listeners share one socket). The connection is created
 * lazily on first use and torn down only when explicitly disconnected.
 */

let socket: Socket | null = null;
let currentToken: string | null = null;

/**
 * Get the shared Socket.IO connection, (re)connecting with the given Oxy access
 * token. If the token changed since the last call, the existing socket is torn
 * down and a fresh authenticated connection is opened so the server re-validates
 * the new session. Returns `null` when no token is available (anonymous).
 */
export function getSocket(token: string | null): Socket | null {
  if (!token) {
    return null;
  }

  if (socket && currentToken === token) {
    return socket;
  }

  // Token changed (sign-in / refresh) — drop the stale connection so the server
  // re-authenticates the new session and re-joins the correct user room.
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentToken = token;
  socket = io(config.apiUrl, {
    auth: { token },
    transports: ['websocket', 'polling'],
    autoConnect: true,
  });

  return socket;
}

/** Tear down the shared connection (e.g. on sign-out). */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    currentToken = null;
  }
}

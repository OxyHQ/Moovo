import { io, type Socket } from "socket.io-client";
import config from "./config";

/**
 * Socket.IO connection manager for the courier surface.
 *
 * The backend authenticates EVERY connection from `handshake.auth.token` (an Oxy
 * access token) and joins the socket to the server-verified `user:<oxyUserId>`
 * room — clients never name their own room. A single shared connection is reused
 * across the app: `connectSocket(token)` (re)connects with the current token,
 * `getSocket()` returns the live instance, and `disconnectSocket()` tears it down
 * on sign-out. The connection is lazy — it is only opened once a signed-in
 * courier mounts the job-socket hook.
 */

let socket: Socket | null = null;
let currentToken: string | null = null;

/** Transports the backend accepts, in preference order (websocket, then polling). */
const TRANSPORTS = ["websocket", "polling"] as const;

/**
 * Connect (or reconnect) the shared socket with `token`. If a live connection
 * already exists for the same token it is returned unchanged; a token change
 * tears the old connection down and opens a fresh one so the room identity always
 * reflects the current session.
 */
export function connectSocket(token: string): Socket {
  if (socket && socket.connected && currentToken === token) {
    return socket;
  }
  if (socket && currentToken !== token) {
    socket.disconnect();
    socket = null;
  }
  if (!socket) {
    socket = io(config.apiUrl, {
      auth: { token },
      transports: [...TRANSPORTS],
      autoConnect: true,
    });
    currentToken = token;
  } else if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

/** The live shared socket, or `null` when not yet connected. */
export function getSocket(): Socket | null {
  return socket;
}

/** Tear the shared connection down (e.g. on sign-out). */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    currentToken = null;
  }
}

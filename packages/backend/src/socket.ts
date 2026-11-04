import { observeEcosystemSocket } from './ecosystemActivity';
import { Server } from 'socket.io';
import { createOxySocketCors } from '@oxy.so/core/server';
import { createAdapter } from '@socket.io/redis-adapter';
import type http from 'node:http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { oxyClient } from './middleware/auth.js';
import { log } from './lib/logger.js';
import { MOOVO_APP_ORIGINS } from './lib/origins.js';

let io: Server | null = null;

export function initSocket(server: http.Server) {
  // Hold the instance in a local const so the async adapter callback below
  // references a provably-defined server (no module-level non-null assertion).
  // The same browser origins as HTTP, on the polling transport AND the
  // WebSocket handshake (which browsers never subject to CORS).
  const socketServer = new Server(server, {
    ...createOxySocketCors({ appOrigins: [...MOOVO_APP_ORIGINS] }),
    transports: ['websocket', 'polling'],
  });
  io = socketServer;

  // Attach Redis adapter for horizontal scaling
  const pubClient = getRedisClient();
  const subClient = getRedisSubClient();
  if (pubClient && subClient) {
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        socketServer.adapter(createAdapter(pubClient, subClient));
        log.general.info('Socket.IO Redis adapter attached');
      })
      .catch((err) => {
        log.general.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory');
      });
  }

  // Authenticate EVERY connection: validates the Oxy session from
  // `handshake.auth.token` and sets `socket.data.userId`. Unauthenticated
  // connections are rejected. This is the ONLY source of the room identity —
  // clients can no longer name the room they join.
  socketServer.use(oxyClient.middleware.socket());

  socketServer.on('connection', (socket) => {
    observeEcosystemSocket(socket);
    const userId = (socket.data as { userId?: string }).userId;
    if (!userId) {
      // middleware.socket() guarantees userId, but fail closed if it is ever missing.
      socket.disconnect(true);
      return;
    }
    // Auto-join the user's own room using the SERVER-VERIFIED id only.
    socket.join(`user:${userId}`);

    // Parameterless opt-in event kept for client compatibility — it is a
    // no-op because the verified room is already joined above. It NEVER
    // joins a client-supplied id.
    socket.on('subscribe-notifications', () => {});
  });

  return socketServer;
}

export function getIO(): Server | null {
  return io;
}

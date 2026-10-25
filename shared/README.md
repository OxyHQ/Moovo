# App socket lifecycle

The three authenticated Moovo apps share `session-socket.ts`. This module owns
Socket.IO connection cleanup; Oxy's linked client owns bearer refresh and origin
validation. Each subscriber disposes its connection on unmount. Account switches
and logout close it immediately, including a pending handshake. Reconnection
asks the shared client for a fresh token, and the backend chooses the verified
user room. Notification and job listeners check the captured account epoch.

This is private app code, watched by the existing monorepo Metro configuration;
it is not part of the public transport SDK or the anonymous tracking API.

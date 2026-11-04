/**
 * The browser origins Moovo's API admits, on HTTP (`createOxyCors`) and on
 * Socket.IO (`createOxySocketCors`) alike — one list, so the two transports
 * cannot drift. The SDK adds Oxy's own HTTPS origin family; native apps send no
 * `Origin` and need no entry.
 */
import { config } from '../config/index.js';

/** The customer app (apex and `www`), Moovo Go, Moovo Hub and Moovo Tracker. */
const MOOVO_WEB_ORIGINS = [
  'https://moovo.now',
  'https://www.moovo.now',
  'https://go.moovo.now',
  'https://hub.moovo.now',
  'https://tracker.moovo.now',
];

/** Expo web and Vite dev servers, including the Android emulator's host alias. */
const DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://10.0.2.2:8081',
];

export const MOOVO_APP_ORIGINS: readonly string[] = [
  ...new Set([config.web.origin, ...MOOVO_WEB_ORIGINS, ...DEVELOPMENT_ORIGINS]),
];

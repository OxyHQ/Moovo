import { Platform } from 'react-native';

/**
 * Centralized API configuration.
 *
 * Moovo Tracker talks to the SAME backend as the customer app, Go and Hub —
 * `/tracking` is mounted on that one Express. There is no tracker-specific API.
 */

export const DEV_API_BASE_URL = 'http://localhost:3001';
export const STAGING_API_BASE_URL = 'https://staging-api.moovo.now';
export const PROD_API_BASE_URL = 'https://api.moovo.now';

// Oxy SSO client id for Moovo Tracker. The committed fallback is Moovo's
// registered public RP client id (oxy_dk_ publicKey) — a public client
// identifier, safe to commit. EXPO_PUBLIC_OXY_CLIENT_ID overrides it at build.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_f0348545dad800903773ddd598183e021cc81e01116ba60b';

const ENV = {
  dev: { apiUrl: DEV_API_BASE_URL },
  staging: { apiUrl: STAGING_API_BASE_URL },
  prod: { apiUrl: PROD_API_BASE_URL },
};

const getEnvVars = () => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return { apiUrl: process.env.EXPO_PUBLIC_API_URL };
  }

  if (!__DEV__) return ENV.prod;

  if (Platform.OS === 'web') {
    return { apiUrl: DEV_API_BASE_URL };
  }

  return ENV.dev;
};

export default getEnvVars();

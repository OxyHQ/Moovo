import axios from 'axios';
import config from '../config';

const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token getter — set by AuthSetup once the Oxy SDK is mounted.
let getAccessToken: (() => string | null) | null = null;

export function setTokenGetter(getter: () => string | null) {
  getAccessToken = getter;
}

/**
 * The Authorization header is attached when a token EXISTS and omitted
 * otherwise, rather than the request being refused.
 *
 * That is the tracker's whole posture: `/tracking` mounts `optionalAuth`, so
 * `carriers`, `detect` and `lookup` answer a signed-out stranger, and only the
 * `/parcels` routes require a user. A client that insisted on a token would
 * break the anonymous lookup, which is the product.
 */
apiClient.interceptors.request.use((request) => {
  const token = getAccessToken?.();
  if (token) {
    request.headers['Authorization'] = `Bearer ${token}`;
  }
  return request;
});

export default apiClient;

/**
 * The human-readable message from a failed Moovo request.
 *
 * The API answers errors with the canonical envelope
 * (`{ success: false, error, message }`), where `error` is a machine code and
 * `message` is the sentence written for a person. Reading `message` is what
 * makes a rate limit say "demasiadas consultas" instead of the axios default,
 * `Request failed with status code 429`.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: string } | undefined)?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

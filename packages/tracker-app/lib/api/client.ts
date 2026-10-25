import axios from 'axios';
import type { OxyServices, LinkedHttpClient } from '@oxy.so/core';
import config from '../config';

let identity: OxyServices | undefined;
let linked: LinkedHttpClient | undefined;

/** The provider owns identity and refresh; this adapter preserves Axios response handling. */
export function setOxyServices(oxy: OxyServices): void {
  if (identity === oxy) return;
  linked?.dispose();
  identity = oxy;
  linked = oxy.createLinkedClient({ baseURL: config.apiUrl });
}

const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 15000,
  adapter: 'fetch',
  xsrfCookieName: '',
  withCredentials: false,
  env: {
    // @ts-expect-error Axios supports null to disable Request construction; its declaration omits null. Preserve replayable JSON for Oxy's shared transport.
    Request: null,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (!linked) return Promise.reject(new Error('Oxy provider is not ready'));
      // Public routes remain anonymous when signed out. A signed-in request still
      // uses shared refresh, account switching and the same-origin boundary.
      if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
        // Fetch owns multipart boundaries, including React Native URI parts.
        const headers = new Headers(init.headers);
        headers.delete('content-type');
        return linked.fetchOptional(input, { ...init, headers });
      }
      return linked.fetchOptional(input, init);
    },
  },
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

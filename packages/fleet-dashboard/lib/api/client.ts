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
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
  adapter: 'fetch',
  xsrfCookieName: '',
  withCredentials: false,
  env: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (!linked) return Promise.reject(new Error('Oxy provider is not ready'));
      // Public routes remain anonymous when signed out. A signed-in request still
      // uses shared refresh, account switching and the same-origin boundary.
      return linked.fetchOptional(input, init);
    },
  },
});

export default apiClient;

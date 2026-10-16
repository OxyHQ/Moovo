import type { OxyServices } from '@oxy.so/core';
import {
  AuthorizeTransport,
  CreateTransport,
  ErrorBody,
  Id,
  Transport,
  TransportAction,
  TransportRead,
  type TransportRequest,
  type TransportAuthorizationInput,
  type TransportActionInput,
  type TransportErrorCode,
} from '@oxy.so/moovo-contracts';
export type {
  TransportRequest,
  TransportView,
  TransportAuthorizationInput,
  TransportActionInput,
  TransportEndpoint,
} from '@oxy.so/moovo-contracts';
export class MoovoApiError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MoovoApiError';
  }
}
export interface MoovoClientOptions {
  apiBaseUrl?: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  requestAuthenticatedResponse?: (input: {
    url: string;
    method: 'GET' | 'POST';
    body?: string;
    signal: AbortSignal;
  }) => Promise<Response>;
}
/** No automatic write retries. Unknown responses are resolved through get/byReservation. */
export function createMoovoClient(options: MoovoClientOptions) {
  const base = new URL(options.apiBaseUrl ?? 'https://api.moovo.now');
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname))
  )
    throw new Error('Moovo requires a secure API origin');
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const token = await options.getAccessToken?.();
    if (!token && !options.requestAuthenticatedResponse)
      throw new MoovoApiError('unauthorized', 'Sign in to Moovo', 401);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    try {
      const url = `${base.origin}/api/v1${path}`;
      const response = options.requestAuthenticatedResponse
        ? await options.requestAuthenticatedResponse({
            url,
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          })
        : await (options.fetch ?? globalThis.fetch)(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
      const data: unknown = await response.json();
      if (!response.ok) {
        const parsed = ErrorBody.parse(data);
        throw new MoovoApiError(parsed.error.code, parsed.error.message, response.status);
      }
      return Transport.parse(data);
    } finally {
      clearTimeout(timer);
    }
  };
  const segment = (id: string) => encodeURIComponent(Id.parse(id));
  const query = (accountId: string) =>
    `?accountId=${encodeURIComponent(TransportRead.parse({ accountId }).accountId)}`;
  return {
    transports: {
      create: (input: TransportRequest) =>
        request('POST', '/transports', CreateTransport.parse(input)),
      get: (id: string, accountId: string) =>
        request('GET', `/transports/${segment(id)}${query(accountId)}`),
      byReservation: (id: string, accountId: string) =>
        request('GET', `/reservations/${segment(id)}/transport${query(accountId)}`),
      quote: (id: string, input: TransportActionInput) =>
        request('POST', `/transports/${segment(id)}/quotes`, TransportAction.parse(input)),
      authorize: (id: string, input: TransportAuthorizationInput) =>
        request('POST', `/transports/${segment(id)}/authorize`, AuthorizeTransport.parse(input)),
      book: (id: string, input: TransportActionInput) =>
        request('POST', `/transports/${segment(id)}/book`, TransportAction.parse(input)),
      cancel: (id: string, input: TransportActionInput) =>
        request('POST', `/transports/${segment(id)}/cancel`, TransportAction.parse(input)),
    },
  };
}

/** Retains Oxy's refresh/session ownership, without interceptors or token forwarding. */
export function moovoForOxy(
  oxy: Pick<OxyServices, 'createLinkedClient'>,
  options: Omit<MoovoClientOptions, 'getAccessToken' | 'requestAuthenticatedResponse'> = {},
) {
  const linked = oxy.createLinkedClient({ baseURL: options.apiBaseUrl ?? 'https://api.moovo.now' });
  const client = createMoovoClient({
    ...options,
    requestAuthenticatedResponse: (input) =>
      linked.client.requestAuthenticatedResponse({
        ...input,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  return { ...client, dispose: () => linked.dispose() };
}

/** Moovo courier FAIR uses 100 minor units, distinct from Mercaria's money scale. */
export function formatTransportPrice(
  quote: { amountMinor: number; currency: 'FAIR' },
  locale: string,
): string {
  if (!Number.isSafeInteger(quote.amountMinor) || quote.amountMinor < 0)
    throw new Error('Invalid transport amount');
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(quote.amountMinor / 100)} ${quote.currency}`;
}

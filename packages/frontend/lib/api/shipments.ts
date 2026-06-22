import type {
  Shipment,
  CreateShipmentInput,
  ShipmentQuery,
  QuoteList,
  BookShipmentInput,
  BookResult,
  ApiResponse,
  PaginatedResponse,
} from '@moovo/shared-types';
import apiClient from './client';

/**
 * Shipments API client — the customer's request → quotes → booking flow.
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the shipment/quote/job shapes. Every call is bearer-auth'd by
 * the axios request interceptor (`client.ts`); ownership is enforced server-side.
 * Each helper unwraps the canonical `ApiResponse<T>` envelope and returns the
 * payload (throwing if the backend reported a non-`data` failure).
 */

/** Unwrap an `ApiResponse<T>` envelope, throwing the message on a failed/empty body. */
function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.message ?? body.error ?? 'Request failed');
  }
  return body.data;
}

/** Create a shipment (→ status `quoting`) and return the created shipment DTO. */
export async function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  const { data } = await apiClient.post<ApiResponse<Shipment>>('/shipments', input);
  return unwrap(data);
}

/** List the caller's shipments (compact DTOs, paginated, newest first). */
export async function fetchMyShipments(
  query: ShipmentQuery = {},
): Promise<PaginatedResponse<Shipment>> {
  const { data } = await apiClient.get<PaginatedResponse<Shipment>>('/shipments', {
    params: query,
  });
  return data;
}

/** Fetch a single shipment owned by the caller. */
export async function fetchShipment(id: string): Promise<Shipment> {
  const { data } = await apiClient.get<ApiResponse<Shipment>>(`/shipments/${id}`);
  return unwrap(data);
}

/** Fetch the display-converted quotes generated for the caller's shipment. */
export async function fetchShipmentQuotes(
  id: string,
  currency?: string,
): Promise<QuoteList> {
  const { data } = await apiClient.get<ApiResponse<QuoteList>>(`/shipments/${id}/quotes`, {
    params: currency ? { currency } : undefined,
  });
  return unwrap(data);
}

/** Book a selected quote (creates exactly one job) and return the created job. */
export async function bookShipment(
  id: string,
  input: BookShipmentInput,
): Promise<BookResult> {
  const { data } = await apiClient.post<ApiResponse<BookResult>>(`/shipments/${id}/book`, input);
  return unwrap(data);
}

/** Cancel the caller's own (non-booked) shipment. */
export async function cancelShipment(id: string): Promise<Shipment> {
  const { data } = await apiClient.post<ApiResponse<Shipment>>(`/shipments/${id}/cancel`, {});
  return unwrap(data);
}

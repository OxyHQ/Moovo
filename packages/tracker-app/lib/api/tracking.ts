import type {
  ApiResponse,
  CarrierGuess,
  PublicParcelLookup,
  TrackedParcel,
  TrackedParcelDetail,
  TrackingCarrierSummary,
  TrackParcelInput,
  UpdateTrackedParcelInput,
} from '@moovo/shared-types';
import apiClient from './client';

/**
 * Moovo Tracker API client.
 *
 * Typed against `@moovo/shared-types` so this app and the backend agree on
 * every shape. Two auth postures, mirroring `routes/tracking.ts`: `carriers`,
 * `detect` and `lookup` answer anyone, while everything under `/parcels`
 * requires a signed-in Oxy user.
 *
 * Every `:id` here is a SUBSCRIPTION id, never the shared parcel's — the parcel
 * row is shared by everyone tracking that number.
 */

/** Unwrap the canonical Moovo envelope, which always carries `data` on success. */
function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.message ?? 'Request failed');
  }
  return body.data;
}

/** The carrier catalogue, for the picker. */
export async function fetchCarriers(): Promise<TrackingCarrierSummary[]> {
  const { data } = await apiClient.get<ApiResponse<TrackingCarrierSummary[]>>(
    '/tracking/carriers',
  );
  return unwrap(data);
}

/** Which carriers a number might belong to. No carrier call is spent. */
export async function detectCarrier(
  number: string,
  destinationCountry?: string,
): Promise<{ carrierKey: string | null; candidates: CarrierGuess[] }> {
  const { data } = await apiClient.post<
    ApiResponse<{ carrierKey: string | null; candidates: CarrierGuess[] }>
  >('/tracking/detect', { number, destinationCountry });
  return unwrap(data);
}

/**
 * The anonymous lookup — the top of the funnel.
 *
 * Persists nothing per person: no subscription, no notification, no identity.
 * It refreshes the SHARED parcel row, which is the cache every later watcher
 * benefits from, and costs exactly one carrier call.
 */
export async function lookupParcel(input: {
  number: string;
  carrierKey?: string;
  destinationPostalCode?: string;
}): Promise<PublicParcelLookup> {
  const { data } = await apiClient.post<ApiResponse<PublicParcelLookup>>(
    '/tracking/lookup',
    input,
  );
  return unwrap(data);
}

/** The signed-in user's own list. */
export async function fetchMyParcels(params: {
  page?: number;
  limit?: number;
  archived?: boolean;
}): Promise<{ parcels: TrackedParcel[]; page: number; limit: number }> {
  const { data } = await apiClient.get<
    ApiResponse<{ parcels: TrackedParcel[]; page: number; limit: number }>
  >('/tracking/parcels', { params });
  return unwrap(data);
}

/** Subscribe to a parcel. This is the only thing that arms the poller. */
export async function trackParcel(input: TrackParcelInput): Promise<TrackedParcel> {
  const { data } = await apiClient.post<ApiResponse<TrackedParcel>>(
    '/tracking/parcels',
    input,
  );
  return unwrap(data);
}

export async function fetchParcel(subscriptionId: string): Promise<TrackedParcelDetail> {
  const { data } = await apiClient.get<ApiResponse<TrackedParcelDetail>>(
    `/tracking/parcels/${subscriptionId}`,
  );
  return unwrap(data);
}

export async function updateParcel(
  subscriptionId: string,
  patch: UpdateTrackedParcelInput,
): Promise<TrackedParcel> {
  const { data } = await apiClient.patch<ApiResponse<TrackedParcel>>(
    `/tracking/parcels/${subscriptionId}`,
    patch,
  );
  return unwrap(data);
}

export async function untrackParcel(subscriptionId: string): Promise<void> {
  await apiClient.delete<ApiResponse<{ removed: boolean }>>(
    `/tracking/parcels/${subscriptionId}`,
  );
}

/**
 * Ask for a parcel to be checked now.
 *
 * Answers 202 and never calls the carrier inline, so the freshly fetched
 * checkpoints arrive on the NEXT read rather than in this response.
 */
export async function refreshParcel(subscriptionId: string): Promise<void> {
  await apiClient.post<ApiResponse<{ queued: boolean }>>(
    `/tracking/parcels/${subscriptionId}/refresh`,
  );
}

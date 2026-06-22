import type { ApiResponse, CourierProfile } from '@moovo/shared-types';
import apiClient from './client';

/**
 * Courier API client.
 *
 * Typed against the shared `@moovo/shared-types` contract so the frontend and
 * backend agree on the courier-profile shape. These are the private,
 * bearer-authenticated endpoints the courier "on the road" surface is built on:
 * the signed-in courier reads their own aggregate profile and flips their
 * real-time availability between online and offline.
 */

/** Fetch the signed-in courier's own profile (aggregates + availability). */
export async function fetchCourierMe(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.get<ApiResponse<CourierProfile>>('/courier/me');
  return data;
}

/** Flip the signed-in courier to `online` so they can be offered jobs. */
export async function goOnline(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>('/courier/online');
  return data;
}

/** Flip the signed-in courier to `offline` so they stop being offered jobs. */
export async function goOffline(): Promise<ApiResponse<CourierProfile>> {
  const { data } = await apiClient.post<ApiResponse<CourierProfile>>('/courier/offline');
  return data;
}

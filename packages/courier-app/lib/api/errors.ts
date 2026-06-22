import axios, { type AxiosError } from "axios";
import type { ApiResponse } from "@moovo/shared-types";

/**
 * Typed helpers for reading the Moovo API error envelope off an axios error.
 *
 * The backend returns `{ success: false, error: <code>, message: <human> }` with
 * an HTTP status. These helpers extract the machine code / human message and
 * detect the CONFLICT case (a 409, used when an offer was won by another courier)
 * without resorting to `as any`.
 */

/** The error body shape the API serializes on failures. */
type ApiErrorBody = ApiResponse<unknown>;

/** Narrow an unknown thrown value to an axios error carrying the API envelope. */
function asApiError(error: unknown): AxiosError<ApiErrorBody> | null {
  return axios.isAxiosError(error) ? (error as AxiosError<ApiErrorBody>) : null;
}

/** Whether `error` is an HTTP 409 / `CONFLICT` API error (e.g. offer taken). */
export function isApiConflict(error: unknown): boolean {
  const apiError = asApiError(error);
  if (!apiError) return false;
  return apiError.response?.status === 409 || apiError.response?.data?.error === "CONFLICT";
}

/**
 * Extract a human-readable message from an unknown thrown value, preferring the
 * API envelope's `message`, then a plain `Error.message`, then `fallback`.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const apiError = asApiError(error);
  const apiMessage = apiError?.response?.data?.message;
  if (typeof apiMessage === "string" && apiMessage.length > 0) {
    return apiMessage;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

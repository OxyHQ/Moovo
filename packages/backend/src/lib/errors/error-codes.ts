/**
 * Moovo typed application error.
 *
 * `MoovoError` carries the SAME machine-readable `ErrorCode` vocabulary that
 * the API envelope emits (`utils/api-response.ts` `ErrorCodes`) plus a derived
 * HTTP status. Service-layer code throws these; thin controllers map them onto
 * the response with `respondWithError` (see `utils/api-response.ts`). Keeping one
 * code vocabulary means there is never a translation layer between business
 * errors and the wire contract.
 */

import type { Response } from 'express';
import { ErrorCodes, sendError, type ErrorCode } from '../../utils/api-response.js';

/** The error code vocabulary, identical to the API envelope's `ErrorCode`. */
export type MoovoErrorCode = ErrorCode;

/** Default HTTP status for each error code. */
const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCodes.VALIDATION_ERROR]: 400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.OUT_OF_STOCK]: 409,
  [ErrorCodes.INTERNAL_ERROR]: 500,
};

export interface MoovoErrorParams {
  code: MoovoErrorCode;
  /** User-facing message (safe to display). */
  message: string;
  httpStatus?: number;
  cause?: unknown;
}

export class MoovoError extends Error {
  readonly code: MoovoErrorCode;
  readonly httpStatus: number;

  constructor(params: MoovoErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'MoovoError';
    this.code = params.code;
    this.httpStatus = params.httpStatus ?? DEFAULT_HTTP_STATUS[params.code];
  }
}

export function isMoovoError(err: unknown): err is MoovoError {
  return err instanceof MoovoError;
}

/** Coerce an unknown thrown value into a MoovoError (defaults to INTERNAL_ERROR). */
export function toMoovoError(err: unknown): MoovoError {
  if (isMoovoError(err)) return err;
  const message = err instanceof Error ? err.message : 'Internal server error';
  return new MoovoError({ code: ErrorCodes.INTERNAL_ERROR, message, cause: err });
}

/** A not-found domain error (404). */
export function notFound(message: string): MoovoError {
  return new MoovoError({ code: ErrorCodes.NOT_FOUND, message });
}

/** A forbidden domain error (403). */
export function forbidden(message: string): MoovoError {
  return new MoovoError({ code: ErrorCodes.FORBIDDEN, message });
}

/** A conflict domain error (409). */
export function conflict(message: string): MoovoError {
  return new MoovoError({ code: ErrorCodes.CONFLICT, message });
}

/** A validation domain error (400). */
export function validationError(message: string): MoovoError {
  return new MoovoError({ code: ErrorCodes.VALIDATION_ERROR, message });
}

/** An out-of-stock domain error (409). */
export function outOfStock(message: string): MoovoError {
  return new MoovoError({ code: ErrorCodes.OUT_OF_STOCK, message });
}

/**
 * Map a caught error onto the response. A `MoovoError` (thrown by the service
 * layer) is emitted with its own code + HTTP status; anything else is treated as
 * an unexpected internal error (500, `INTERNAL_ERROR`) with a generic message so
 * internals never leak.
 */
export function respondWithError(res: Response, err: unknown, fallbackMessage: string): void {
  if (isMoovoError(err)) {
    sendError(res, err.code, err.message, err.httpStatus);
    return;
  }
  sendError(res, ErrorCodes.INTERNAL_ERROR, fallbackMessage, 500);
}

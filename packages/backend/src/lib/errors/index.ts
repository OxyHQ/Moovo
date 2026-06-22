/**
 * Moovo Error System
 *
 * Generic typed error class + user-facing sanitization helpers.
 */

export {
  MoovoError,
  isMoovoError,
  toMoovoError,
  notFound,
  forbidden,
  conflict,
  validationError,
  outOfStock,
  respondWithError,
  type MoovoErrorCode,
  type MoovoErrorParams,
} from './error-codes.js';

export {
  sanitizeMessage,
  sanitizeError,
  getSafeErrorMessage,
} from './sanitize.js';

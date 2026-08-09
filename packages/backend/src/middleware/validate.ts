/**
 * Request validation middleware (Zod).
 *
 * Ported from Mention's `middleware/validate.ts`, but every validation failure
 * is routed through Moovo's `sendError(res, ErrorCodes.VALIDATION_ERROR, …)`
 * so it emits the canonical Moovo envelope (`error` as a string code) rather
 * than Mention's nested `{ code, message }` shape.
 *
 * Domain schemas (listing, store, cart, …) are added by their respective
 * phases; this module provides only the reusable middleware factories.
 */

import type { Request, Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import { z } from 'zod';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** Flatten Zod issues into a single human-readable message. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate `req.body` against `schema`. On success, replaces `req.body` with
 * the parsed (and possibly defaulted/coerced) result; on failure responds 400.
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, formatIssues(result.error), 400);
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate `req.query` against `schema`. On success, replaces `req.query` with
 * the parsed result; on failure responds 400.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, formatIssues(result.error), 400);
      return;
    }
    req.query = result.data as typeof req.query;
    next();
  };
}

/**
 * Ensure `req.params[paramName]` is a live entity id. Responds 400 when the
 * param is missing or malformed.
 *
 * This accepts BOTH id shapes a Moovo row can have, which is the whole point:
 * a primary key is `text` holding a 24-char ObjectId hex for every row that
 * existed before the Postgres cutover, and a uuid v7 for every row created
 * after it. Both are live simultaneously and permanently, because a backfill
 * copies the original id verbatim rather than reassigning it.
 *
 * It was `isValidObjectId` until the port. Left alone, every route guarded by
 * it would answer 400 for every row created after its domain moved — a clean
 * rejection of a perfectly valid id, on the happy path, discoverable only by
 * creating a row and then fetching it. The widening is safe to land early
 * because an ObjectId hex still passes; what it adds is the shape that does not
 * exist yet.
 *
 * Deliberately NOT a loose "is this a non-empty string" check: it rejects uuid
 * v4, short hex, and anything with punctuation, so a route param still cannot
 * carry an arbitrary string into a query.
 *
 * @param paramName - The route param to validate (default `'id'`).
 */
export function validateEntityId(paramName = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.params[paramName];
    // Express params can be string[] when a path repeats a segment name.
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `${paramName} parameter is required`, 400);
      return;
    }
    if (!isLiveEntityId(id)) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `Invalid ${paramName} format`, 400);
      return;
    }
    next();
  };
}

/**
 * Tracking controller (THIN).
 *
 * Serves `/tracking`. Every decision lives in `services/tracking/`; this reads
 * the caller, calls the service and shapes the envelope.
 *
 * Two postures on one router. `POST /tracking/lookup` and the two catalogue
 * routes answer ANYONE — that is the product, and it is why the router mounts
 * `optionalAuth` rather than `authenticateToken`. Everything that touches a
 * list requires a real Oxy user, because a list is a thing that belongs to
 * somebody.
 *
 * The `:id` in every path is a SUBSCRIPTION id, never `tracked_parcels.id`. The
 * parcel row is shared by everyone tracking that number, so exposing its id
 * would let anyone who learned one read a parcel they never added.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import {
  detectCarriersForNumber,
  getParcelDetail,
  listCarriers,
  listParcels,
  lookupParcel,
  requestRefresh,
  trackParcel,
  untrackParcel,
  updateParcel,
} from '../services/tracking/tracking.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, unauthorized } from '../lib/errors/error-codes.js';
import { parsePagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { resolveDisplayCurrency } from '../utils/fair-display.js';
import { log } from '../lib/logger.js';

/**
 * The caller's Oxy id, or a 401.
 *
 * This router mounts `optionalAuth`, so a signed-out request reaches the
 * controller rather than being turned away by middleware — which is the point,
 * because three of these routes answer anyone. That makes THIS the gate for the
 * rest, and it has to produce a 401: `getRequiredOxyUserId` throws a plain
 * error, which `respondWithError` would report as a 500. "Not signed in" must
 * not look like an outage.
 */
function requireUser(req: Request): string {
  try {
    return getRequiredOxyUserId(req);
  } catch {
    throw unauthorized('Sign in to manage your parcels');
  }
}

/** The catalogue, for the carrier picker. */
export async function getCarriers(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listCarriers());
  } catch (err) {
    log.general.error({ err }, 'Failed to list tracking carriers');
    respondWithError(res, err, 'Failed to list carriers');
  }
}

/** Which carriers a number might belong to. No I/O beyond the catalogue read. */
export async function detectCarrier(req: Request, res: Response): Promise<void> {
  try {
    const { number, destinationCountry } = req.body as {
      number: string;
      destinationCountry?: string;
    };
    sendSuccess(res, await detectCarriersForNumber(number, destinationCountry));
  } catch (err) {
    log.general.error({ err }, 'Carrier detection failed');
    respondWithError(res, err, 'Could not identify the carrier');
  }
}

/**
 * The anonymous lookup.
 *
 * Persists nothing per person — no subscription, no notification, no identity.
 * It does create or refresh the SHARED parcel row, which is the cache every
 * later watcher benefits from, born with no subscriber and therefore no due
 * time. What comes back is built from an allow-list; see `public-facts.ts`.
 */
export async function lookup(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      number: string;
      carrierKey?: string;
      destinationPostalCode?: string;
    };
    sendSuccess(res, await lookupParcel(body));
  } catch (err) {
    log.general.error({ err }, 'Parcel lookup failed');
    respondWithError(res, err, 'Could not look up that parcel');
  }
}

export async function listMyParcels(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    const { page, limit } = parsePagination(req.query);
    const archived = req.query.archived === 'true';

    const parcels = await listParcels(oxyUserId, {
      limit,
      offset: (page - 1) * limit,
      includeArchived: archived,
    });
    sendSuccess(res, { parcels, page, limit });
  } catch (err) {
    log.general.error({ err }, 'Failed to list tracked parcels');
    respondWithError(res, err, 'Failed to load your parcels');
  }
}

export async function addParcel(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    const parcel = await trackParcel(oxyUserId, req.body as Parameters<typeof trackParcel>[1]);
    sendSuccess(res, parcel, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to track parcel');
    respondWithError(res, err, 'Could not add that parcel');
  }
}

export async function getParcel(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    const currency = resolveDisplayCurrency(
      typeof req.query.currency === 'string' ? req.query.currency : undefined,
    );
    sendSuccess(res, await getParcelDetail(routeParam(req, 'id'), oxyUserId, currency));
  } catch (err) {
    log.general.error({ err }, 'Failed to load tracked parcel');
    respondWithError(res, err, 'Could not load that parcel');
  }
}

export async function patchParcel(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    const updated = await updateParcel(
      routeParam(req, 'id'),
      oxyUserId,
      req.body as Parameters<typeof updateParcel>[2],
    );
    sendSuccess(res, updated);
  } catch (err) {
    log.general.error({ err }, 'Failed to update tracked parcel');
    respondWithError(res, err, 'Could not update that parcel');
  }
}

export async function deleteParcel(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    await untrackParcel(routeParam(req, 'id'), oxyUserId);
    sendSuccess(res, { removed: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to untrack parcel');
    respondWithError(res, err, 'Could not remove that parcel');
  }
}

/**
 * Ask for a parcel to be checked now.
 *
 * Returns 202 and never calls the carrier inline: a request thread must not
 * hold a carrier's timeout open, and doing so would let one slow carrier
 * exhaust the connection pool.
 */
export async function refreshParcel(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = requireUser(req);
    await requestRefresh(routeParam(req, 'id'), oxyUserId);
    sendSuccess(res, { queued: true }, 202);
  } catch (err) {
    log.general.error({ err }, 'Failed to queue parcel refresh');
    respondWithError(res, err, 'Could not refresh that parcel');
  }
}

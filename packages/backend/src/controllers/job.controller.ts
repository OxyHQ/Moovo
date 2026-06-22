/**
 * Job controller (THIN).
 *
 * Serves the job lifecycle under `/jobs`: list (as sender OR assigned courier via
 * a `?role=` toggle), get, and the courier lifecycle actions (accept, pickup,
 * in-transit, deliver, location ping) + cancel. All logic lives in `job.service`
 * (assignment/claimability checks + CAS transitions); DTOs are built through
 * `job-hydration.service`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { JobStatus, DeliverInput, GeoPoint } from '@moovo/shared-types';
import {
  listForSender,
  listForCourier,
  getVisible,
  accept,
  pickup,
  startTransit,
  deliver,
  pingLocation,
  cancel,
} from '../services/job.service.js';
import { hydrateJob, summarizeJobs } from '../services/job-hydration.service.js';
import { resolveDisplayCurrency } from '../utils/fair-display.js';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/** Read the requested display currency from `?currency=`. */
function displayCurrencyFromQuery(req: Request): ReturnType<typeof resolveDisplayCurrency> {
  const raw = req.query.currency;
  return resolveDisplayCurrency(typeof raw === 'string' ? raw : undefined);
}

/** Read an optional `{ lng, lat }` location from the request body. */
function locationFromBody(body: { lng?: number; lat?: number }): GeoPoint | undefined {
  if (typeof body.lng === 'number' && typeof body.lat === 'number') {
    return { type: 'Point', coordinates: [body.lng, body.lat] };
  }
  return undefined;
}

/**
 * GET /jobs — the caller's jobs. `?role=courier` lists jobs assigned to the
 * caller as a courier; otherwise (default `sender`) lists jobs the caller booked.
 */
export async function listMyJobs(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const status = typeof req.query.status === 'string' ? (req.query.status as JobStatus) : undefined;
    const role = req.query.role === 'courier' ? 'courier' : 'sender';
    const { data, total } =
      role === 'courier'
        ? await listForCourier(oxyUserId, { page, limit, status })
        : await listForSender(oxyUserId, { page, limit, status });
    sendPaginated(
      res,
      await summarizeJobs(data, displayCurrencyFromQuery(req)),
      buildPagination(page, limit, total),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list jobs');
    respondWithError(res, err, 'Failed to load your jobs');
  }
}

/** GET /jobs/:id — a single job visible to the caller (sender or assigned courier). */
export async function getMyJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const job = await getVisible(oxyUserId, id);
    const view = await hydrateJob(job, displayCurrencyFromQuery(req));
    sendSuccess(res, view);
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to load job');
    respondWithError(res, err, 'Failed to load job');
  }
}

/** POST /jobs/:id/accept — a courier accepts a requested job. */
export async function acceptJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const job = await accept(oxyUserId, id);
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to accept job');
    respondWithError(res, err, 'Failed to accept job');
  }
}

/** POST /jobs/:id/pickup — a courier marks the assigned job picked up. */
export async function pickupJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const job = await pickup(oxyUserId, id, locationFromBody(req.body as { lng?: number; lat?: number }));
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to mark job picked up');
    respondWithError(res, err, 'Failed to pick up job');
  }
}

/** POST /jobs/:id/in-transit — a courier marks the assigned job in transit. */
export async function inTransitJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const job = await startTransit(
      oxyUserId,
      id,
      locationFromBody(req.body as { lng?: number; lat?: number }),
    );
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to mark job in transit');
    respondWithError(res, err, 'Failed to update job');
  }
}

/** POST /jobs/:id/deliver — a courier delivers the assigned job (attaches POD). */
export async function deliverJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as DeliverInput & { lng?: number; lat?: number };
    const input: DeliverInput = {};
    if (body.photoFileId) input.photoFileId = body.photoFileId;
    if (body.signatureFileId) input.signatureFileId = body.signatureFileId;
    if (body.note) input.note = body.note;
    if (body.recipientName) input.recipientName = body.recipientName;
    const job = await deliver(oxyUserId, id, input, locationFromBody(body));
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to deliver job');
    respondWithError(res, err, 'Failed to deliver job');
  }
}

/** POST /jobs/:id/location — a courier records a location ping on the assigned job. */
export async function pingJobLocation(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { lng, lat } = req.body as { lng: number; lat: number };
    const job = await pingLocation(oxyUserId, id, { type: 'Point', coordinates: [lng, lat] });
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to record job location');
    respondWithError(res, err, 'Failed to record location');
  }
}

/** POST /jobs/:id/cancel — cancel a job the caller is party to. */
export async function cancelJob(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const job = await cancel(oxyUserId, id);
    sendSuccess(res, await hydrateJob(job, displayCurrencyFromQuery(req)));
  } catch (err) {
    log.general.error({ err, jobId: id }, 'Failed to cancel job');
    respondWithError(res, err, 'Failed to cancel job');
  }
}

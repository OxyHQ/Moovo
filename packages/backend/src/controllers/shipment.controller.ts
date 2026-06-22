/**
 * Shipment controller (THIN).
 *
 * Serves the customer's shipment lifecycle under `/shipments`: create (→ quoting
 * → quoted), list, get, view quotes, book (→ creates a job), and cancel. All
 * logic lives in `shipment.service` / `quote.service` / `job.service`; DTOs are
 * built through `shipment-hydration.service` / `job-hydration.service`. Ownership
 * is enforced in the services, which throw typed `MoovoError`s.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CreateShipmentInput,
  BookShipmentInput,
  ShipmentStatus,
  ShipmentType,
} from '@moovo/shared-types';
import {
  createShipment,
  listMine,
  getMine,
  cancel,
} from '../services/shipment.service.js';
import { listQuotes } from '../services/quote.service.js';
import { bookShipment } from '../services/job.service.js';
import {
  hydrateShipments,
  summarizeShipments,
  hydrateQuotes,
} from '../services/shipment-hydration.service.js';
import { hydrateJob } from '../services/job-hydration.service.js';
import { resolveDisplayCurrency } from '../utils/fair-display.js';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/** Read the requested display currency from `?currency=`. */
function displayCurrencyFromQuery(req: Request): ReturnType<typeof resolveDisplayCurrency> {
  const raw = req.query.currency;
  return resolveDisplayCurrency(typeof raw === 'string' ? raw : undefined);
}

/** POST /shipments — create a shipment and generate its quotes. */
export async function createShipmentHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const shipment = await createShipment(oxyUserId, req.body as CreateShipmentInput);
    const [dto] = await hydrateShipments([shipment]);
    if (!dto) {
      throw notFound('Shipment not found');
    }
    sendSuccess(res, dto, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create shipment');
    respondWithError(res, err, 'Failed to create shipment');
  }
}

/** GET /shipments — the caller's shipments (summaries, paginated, newest first). */
export async function listMyShipments(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const status = typeof req.query.status === 'string' ? (req.query.status as ShipmentStatus) : undefined;
    const type = typeof req.query.type === 'string' ? (req.query.type as ShipmentType) : undefined;
    const { data, total } = await listMine(oxyUserId, { page, limit, status, type });
    sendPaginated(res, await summarizeShipments(data), buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list shipments');
    respondWithError(res, err, 'Failed to load your shipments');
  }
}

/** GET /shipments/:id — a single shipment owned by the caller. */
export async function getMyShipment(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const shipment = await getMine(oxyUserId, id);
    const [dto] = await hydrateShipments([shipment]);
    if (!dto) {
      throw notFound('Shipment not found');
    }
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, shipmentId: id }, 'Failed to load shipment');
    respondWithError(res, err, 'Failed to load shipment');
  }
}

/** GET /shipments/:id/quotes — the quotes generated for the caller's shipment. */
export async function getShipmentQuotes(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    // Ownership check (throws NOT_FOUND/FORBIDDEN if the caller is not the sender).
    await getMine(oxyUserId, id);
    const quotes = await listQuotes(id);
    const list = await hydrateQuotes(id, quotes, displayCurrencyFromQuery(req));
    sendSuccess(res, list);
  } catch (err) {
    log.general.error({ err, shipmentId: id }, 'Failed to load shipment quotes');
    respondWithError(res, err, 'Failed to load quotes');
  }
}

/** POST /shipments/:id/book — book a selected quote (creates exactly one job). */
export async function bookShipmentHandler(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { quoteId, idempotencyKey } = req.body as BookShipmentInput;
    const job = await bookShipment(oxyUserId, id, quoteId, idempotencyKey);
    // The booker is the OWNER (sender): surface the plaintext QR codes so they
    // can show the pickup code and relay the dropoff code to the recipient.
    const view = await hydrateJob(job, displayCurrencyFromQuery(req), { includeCodes: true });
    sendSuccess(res, { job: view }, 201);
  } catch (err) {
    log.general.error({ err, shipmentId: id }, 'Failed to book shipment');
    respondWithError(res, err, 'Failed to book shipment');
  }
}

/** POST /shipments/:id/cancel — cancel the caller's own (non-booked) shipment. */
export async function cancelShipmentHandler(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const shipment = await cancel(oxyUserId, id);
    const [dto] = await hydrateShipments([shipment]);
    if (!dto) {
      throw notFound('Shipment not found');
    }
    sendSuccess(res, dto);
  } catch (err) {
    log.general.error({ err, shipmentId: id }, 'Failed to cancel shipment');
    respondWithError(res, err, 'Failed to cancel shipment');
  }
}

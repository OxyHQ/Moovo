/**
 * `POST /webhooks/tracking/:carrierKey` — where carriers push.
 *
 * ## The mount is part of the correctness, and it has a second trap
 *
 * Mounted BEFORE `express.json()` in `index.ts`, for the reason the CrowdSource
 * router is: a signature covers the bytes that ARRIVED, and once a JSON parser
 * has run those bytes are gone. Mounted ahead of the global rate limiter too,
 * so a burst of legitimate carrier events is not shed as abuse.
 *
 * **`express.raw()` is applied per-route here and must NEVER be mounted at
 * `/webhooks`.** `crowdsource-webhook.test.ts` asserts that `index.ts` contains
 * no `verify` hook and that the string `rawBody` does not appear in it at all,
 * because `@oxy.so/crowdsource-express`'s `readRawBody` prefers a Buffer on
 * `req.rawBody` before reading the stream. Anything that stashes raw bytes
 * upstream changes what a late mount does from LOUD REFUSAL to silent success —
 * which would quietly disarm the neighbouring router's whole guarantee. So
 * every byte of raw-body handling stays inside this file.
 *
 * ## Record and return
 *
 * The handler claims the delivery, schedules the parcel, and answers 202. It
 * does not parse checkpoints inline, and that is the design rather than
 * laziness: parsing here would create a SECOND writer of `tracking_checkpoints`
 * beside the poller, and two writers of one timeline drift. Routing the payload
 * through the poller keeps one ingest path, one dedupe implementation and one
 * notification fan-out — at no extra carrier call, since the payload is already
 * in hand.
 *
 * Nothing here is authenticated by Oxy. The carrier's own signature IS the
 * authentication, and an Oxy session must never satisfy this route.
 */

import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { log } from '../lib/logger.js';
import { getDb } from '../db/postgres.js';
import { getTrackingAdapter } from '../services/tracking/tracking-registry.js';
import {
  claimTrackingWebhookEvent,
  markWebhookEventQueued,
} from '../db/tracking/trackingWebhookEventRepository.js';
import { markParcelWebhookDriven } from '../db/tracking/trackedParcelRepository.js';
import { normalizeTrackingNumber } from '../services/tracking/carrier-detection.js';

/** Largest carrier push we will read. Beyond this the delivery is refused. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Which carriers have a configured secret.
 *
 * Read once, from `TRACKING_WEBHOOK_SECRET_<CARRIER>` — the carrier key
 * uppercased with hyphens as underscores, so `dhl-express` is
 * `TRACKING_WEBHOOK_SECRET_DHL_EXPRESS`.
 */
export function configuredWebhookCarriers(): string[] {
  const prefix = 'TRACKING_WEBHOOK_SECRET_';
  return Object.entries(process.env)
    .filter(([name, value]) => name.startsWith(prefix) && !name.endsWith('_PREVIOUS') && !!value)
    .map(([name]) => name.slice(prefix.length).toLowerCase().replace(/_/g, '-'));
}

function secretsFor(carrierKey: string): string[] {
  const suffix = carrierKey.toUpperCase().replace(/-/g, '_');
  return [
    process.env[`TRACKING_WEBHOOK_SECRET_${suffix}`],
    // Rotation: the previous secret stays valid while carriers roll over, so a
    // rotation is not an outage for whatever is already in flight.
    process.env[`TRACKING_WEBHOOK_SECRET_${suffix}_PREVIOUS`],
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function handle(req: Request, res: Response): Promise<void> {
  const carrierKey = String(req.params.carrierKey ?? '');
  const adapter = getTrackingAdapter(carrierKey);

  if (!adapter?.verifyWebhook || !adapter.parseWebhook) {
    // A carrier with no verifier cannot be trusted, so it is refused rather
    // than accepted-and-ignored. 404 rather than 400: this route does not exist
    // for that carrier.
    log.general.warn({ carrierKey }, '[TrackingWebhook] delivery for a carrier with no verifier');
    res.status(404).json({ error: 'Unknown webhook carrier' });
    return;
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (raw.length === 0) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value[0] : value,
    ]),
  );

  const secrets = secretsFor(carrierKey);
  if (secrets.length === 0) {
    // Configured away since boot. Refusing beats accepting unverified.
    log.general.warn({ carrierKey }, '[TrackingWebhook] no secret configured for carrier');
    res.status(404).json({ error: 'Unknown webhook carrier' });
    return;
  }

  const verdict = adapter.verifyWebhook(raw, headers, secrets);
  if (!verdict.ok) {
    // A bounded label only. Never a header, never a body, never a signature —
    // an attacker must learn nothing from the log they can provoke.
    log.general.warn({ carrierKey, reason: verdict.reason }, '[TrackingWebhook] delivery refused');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // A carrier that sends no delivery id still needs a stable identity, or every
  // redelivery becomes a new row and the dedupe claim protects nothing.
  const eventId =
    verdict.eventId ?? createHash('sha256').update(`${carrierKey}|`).update(raw).digest('hex');

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Body is not JSON' });
    return;
  }

  const snapshot = adapter.parseWebhook(payload);
  const trackingNumber =
    snapshot && typeof payload === 'object' && payload !== null && 'trackingNumber' in payload
      ? normalizeTrackingNumber(String((payload as { trackingNumber: unknown }).trackingNumber))
      : null;

  await getDb().transaction(async (tx) => {
    const claimed = await claimTrackingWebhookEvent(
      { id: eventId, carrierKey, payload },
      tx,
    );
    // The empty result IS the answer "somebody else has this event". 202 either
    // way: a carrier retrying a delivery we already hold must see success, or
    // it will keep retrying forever.
    if (!claimed) return;

    if (trackingNumber) {
      // Schedule, do not ingest. The poller is the one writer of checkpoints.
      await markParcelWebhookDriven(carrierKey, trackingNumber, tx);
      await markWebhookEventQueued(eventId, tx);
    }
  });

  res.status(202).json({ received: true });
}

/**
 * The router, or `null` when no carrier has a secret.
 *
 * Not mounted at all rather than mounted-and-permissive: a route that answers
 * without verifying is one somebody will later reason about as if it verified.
 */
export function createTrackingWebhookRoutes(): Router | null {
  const carriers = configuredWebhookCarriers();
  if (carriers.length === 0) {
    log.general.info('[TrackingWebhook] not mounted: no carrier webhook secret is configured');
    return null;
  }

  const router = Router();
  // Scoped to THIS path. See the header: mounting it at `/webhooks` would put a
  // Buffer on `req.rawBody` and silently disarm the CrowdSource router's
  // late-mount refusal.
  router.post(
    '/tracking/:carrierKey',
    raw({ type: '*/*', limit: MAX_BODY_BYTES }),
    (req, res) => {
      void handle(req, res).catch((error: unknown) => {
        log.general.error({ err: error }, '[TrackingWebhook] delivery handler failed');
        if (!res.headersSent) res.status(500).json({ error: 'Webhook processing failed' });
      });
    },
  );

  log.general.info({ carriers }, '[TrackingWebhook] mounted');
  return router;
}

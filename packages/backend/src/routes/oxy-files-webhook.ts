/**
 * Oxy's file events (oxy ADR 0043 D9): `POST /webhooks/oxy/files`.
 *
 * Mounted BEFORE `express.json()` in `index.ts`, because the signature is an
 * HMAC over the bytes that arrived; its `express.raw` is scoped to this one
 * path for the reason `tracking-webhook.ts` gives (a raw parser at `/webhooks`
 * would disarm the CrowdSource router's own guard).
 *
 * ALWAYS mounted, unlike the carrier webhook: Oxy verifies the endpoint by
 * POSTing a `webhook.challenge` and storing the endpoint only on an echo, and
 * the signing secret exists only AFTER that — it is shown once, in the answer
 * to `oxy.apps.setFilesWebhook`. A challenge carries nothing and changes
 * nothing, so answering it unsigned is safe; every other request is refused
 * unless it verifies against `OXY_FILES_WEBHOOK_SECRET` (or `_PREVIOUS`, so
 * re-registering the endpoint is not an outage). Without a secret, events are
 * answered 503 and Oxy keeps retrying until one is configured.
 */

import { Router, raw } from 'express';
import type { Request, Response } from 'express';
import {
  FileEventVerificationError,
  verifyFileEventSignature,
  type FileEvent,
} from '@oxy.so/core/server';
import { log } from '../lib/logger.js';
import { handleFileEvent } from '../services/files/file-events.service.js';

const MAX_BODY_BYTES = 256 * 1024;

/** The live secret first, then the one being rotated out. Read per request. */
export function filesWebhookSecrets(): string[] {
  return [process.env.OXY_FILES_WEBHOOK_SECRET, process.env.OXY_FILES_WEBHOOK_SECRET_PREVIOUS]
    .map((value) => value?.trim())
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

type Verdict =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'event'; event: FileEvent }
  | { kind: 'unconfigured' }
  | { kind: 'refused'; reason: string };

function verify(body: Buffer, req: Request): Verdict {
  const secrets = filesWebhookSecrets();
  // The challenge is recognised before any secret is consulted (the SDK
  // returns it unchecked), which is what lets the endpoint be verified before
  // a secret exists.
  let lastReason = 'no secret configured';
  for (const secret of secrets.length > 0 ? secrets : ['']) {
    try {
      const verdict = verifyFileEventSignature(body, req.headers, secret);
      if (verdict.type === 'webhook.challenge') {
        return { kind: 'challenge', challenge: verdict.challenge };
      }
      return { kind: 'event', event: verdict };
    } catch (error: unknown) {
      if (!(error instanceof FileEventVerificationError)) throw error;
      lastReason = error.message;
    }
  }
  return secrets.length === 0 ? { kind: 'unconfigured' } : { kind: 'refused', reason: lastReason };
}

async function handle(req: Request, res: Response): Promise<void> {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.length === 0) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  const verdict = verify(body, req);
  switch (verdict.kind) {
    case 'challenge':
      res.status(200).json({ challenge: verdict.challenge });
      return;
    case 'unconfigured':
      log.general.error('[FilesWebhook] event refused: OXY_FILES_WEBHOOK_SECRET is not set');
      res.status(503).json({ error: 'File events are not configured' });
      return;
    case 'refused':
      // A bounded label only: never a header, a body or a signature.
      log.general.warn({ reason: verdict.reason }, '[FilesWebhook] delivery refused');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    case 'event': {
      const outcome = await handleFileEvent(verdict.event);
      res.status(200).json({ received: true, duplicate: outcome.duplicate });
      return;
    }
  }
}

export function createOxyFilesWebhookRoutes(): Router {
  const router = Router();
  router.post('/oxy/files', raw({ type: '*/*', limit: MAX_BODY_BYTES }), (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // 500, so Oxy retries: the receipt and the changes share one
      // transaction, so a failed attempt left nothing behind.
      log.general.error({ err: error }, '[FilesWebhook] delivery handler failed');
      if (!res.headersSent) res.status(500).json({ error: 'Webhook processing failed' });
    });
  });
  return router;
}

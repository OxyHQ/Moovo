/**
 * The webhook must be mounted BEFORE `express.json()`.
 *
 * Two tests, and they are different claims:
 *
 * 1. Mounted first, a correctly signed delivery verifies and is handled.
 * 2. Mounted AFTER the parser, the SAME delivery is refused — because the signed
 *    bytes no longer exist and the middleware will not verify a signature over a
 *    re-serialisation.
 *
 * The second test is the one that gives the first its meaning. Without it, a
 * passing "the webhook works" test would keep passing if somebody moved the mount
 * below the parser in a codebase where the parser happened not to run for that
 * content type — and the inbound half of moderation would break silently in
 * production, where reports keep going out and nothing ever comes back.
 *
 * A third test pins the mount order in `index.ts` itself, since these two build
 * their own apps and cannot see what the real server does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import { createHmac } from 'node:crypto';
import {
  buildWebhookSignedPayload,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@oxyhq/crowdsource-contracts';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEBHOOK_SECRET = 'whsec_test_secret_value';

const recordDecisionEvent = vi.fn();
const recordIgnoredEvent = vi.fn();
const claim = vi.fn();
const release = vi.fn();

vi.mock('../../config/index.js', () => ({
  config: {
    crowdSource: {
      enabled: true,
      serviceKey: 'app:cred:secret',
      baseUrl: undefined,
      webhookSecret: 'whsec_test_secret_value',
      webhookPreviousSecret: undefined,
      outboxBatchSize: 50,
      outboxPollIntervalMs: 5_000,
      enforcementMode: 'observe',
    },
    web: { origin: 'https://moovo.now' },
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { moderation: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../services/moderation/moderation-inbound.service.js', () => ({
  recordDecisionEvent: (...args: unknown[]) => recordDecisionEvent(...args),
  recordIgnoredEvent: (...args: unknown[]) => recordIgnoredEvent(...args),
}));

vi.mock('../../services/moderation/moderation-event-store.js', () => ({
  mongoProcessedEventStore: () => ({
    claim: (...args: unknown[]) => claim(...args),
    release: (...args: unknown[]) => release(...args),
  }),
}));

import { createCrowdSourceWebhookRoutes } from '../crowdsource-webhook.js';

import { decisionEnvelope } from '../../services/moderation/__tests__/decision-fixtures.js';

/** The event id shared by the envelope, the signature header and the assertions. */
const EVENT_ID = 'evt_mount_order_1';

function envelope(): Record<string, unknown> {
  return decisionEnvelope({ eventId: EVENT_ID });
}

/**
 * Headers as a real delivery carries them.
 *
 * Built from the contract's own constants and its `buildWebhookSignedPayload`
 * rather than restating `${timestamp}.${body}` and `v1=` here — a test that
 * hard-codes the scheme keeps passing when the scheme changes, which is the
 * opposite of what it is for.
 */
function signedHeaders(rawBody: string, eventId: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const digest = createHmac('sha256', WEBHOOK_SECRET)
    .update(buildWebhookSignedPayload(timestamp, rawBody), 'utf8')
    .digest('hex');
  return {
    'content-type': 'application/json',
    [WEBHOOK_EVENT_ID_HEADER]: eventId,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_VERSION}=${digest}`,
  };
}

let server: Server | null = null;

async function listen(app: Express): Promise<string> {
  const httpServer = createServer(app);
  server = httpServer;
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  claim.mockResolvedValue(true);
  release.mockResolvedValue(undefined);
  recordDecisionEvent.mockResolvedValue(undefined);
  recordIgnoredEvent.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe('the webhook mounted BEFORE express.json (the real order)', () => {
  it('sees raw bytes: req.body is undefined when the handler runs', async () => {
    const app = express();
    let bodyTypeAtRoute = 'never-ran';
    // A probe on the same path, ahead of the verifier and behind nothing. This is
    // what actually proves no parser ran — a passing signature check alone could
    // in principle be satisfied by some other raw-body source.
    app.use('/webhooks', (req, _res, next) => {
      bodyTypeAtRoute = typeof req.body;
      next();
    });
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    app.use(express.json());

    const base = await listen(app);
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: signedHeaders(rawBody, EVENT_ID),
      body: rawBody,
    });

    expect(bodyTypeAtRoute).toBe('undefined');
    expect(response.status).toBeLessThan(300);
    expect(recordDecisionEvent).toHaveBeenCalledTimes(1);
  });

  it('records the decision it was sent', async () => {
    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    app.use(express.json());

    const base = await listen(app);
    const rawBody = JSON.stringify(envelope());
    await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: signedHeaders(rawBody, EVENT_ID),
      body: rawBody,
    });

    expect(recordDecisionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, caseId: 'case_1' }),
    );
  });
});

describe('the webhook mounted AFTER express.json (the mutation)', () => {
  /**
   * The discriminating half.
   *
   * Same signature, same bytes, same handler — only the mount order differs, and
   * the delivery is refused. If this ever passes, the first test has stopped
   * proving anything about ordering.
   */
  it('refuses the delivery FOR THE RIGHT REASON, and does not record it', async () => {
    const app = express();
    app.use(express.json());
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    /**
     * The error is CAPTURED, not just answered.
     *
     * A status-only assertion cannot tell a configuration refusal apart from a
     * schema rejection: a malformed envelope is answered 400 `malformed_event`,
     * and a bad signature 401, either of which would make this test pass while
     * proving only that the fixture was broken — and it would keep passing if
     * the raw-body guard were deleted outright. Asserting the SPECIFIC failure
     * is what makes it evidence about mount order rather than about the payload.
     *
     * Credit: `allo` and `mercaria`, who each found a refusal test in their own
     * integration passing for the wrong reason.
     */
    let refusal: unknown;
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      refusal = err;
      res.status(500).json({ error: 'configuration' });
    });

    const base = await listen(app);
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: signedHeaders(rawBody, EVENT_ID),
      body: rawBody,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(recordDecisionEvent).not.toHaveBeenCalled();
    // It reached raw-body resolution and refused THERE.
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/body parser ran before/i);
  });

  /**
   * The sibling that gives the refusal its meaning, stated as its own test.
   *
   * A test asserting a request is REFUSED proves nothing unless the same request
   * is otherwise ACCEPTED — otherwise it may only be proving the request was
   * malformed. The "mounted BEFORE" tests are that sibling and share this
   * fixture, so this asserts the property directly rather than leaving it an
   * inference the reader has to make.
   */
  it('uses an envelope that IS accepted when the mount order is right', async () => {
    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    app.use(express.json());

    const base = await listen(app);
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: signedHeaders(rawBody, EVENT_ID),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    // A SIDE-EFFECT assertion, not a status code: an envelope the schema rejects
    // is acknowledged 200 `{ handled: false }` with no handler run, so a
    // status-only check agrees that an inert endpoint works.
    expect(recordDecisionEvent).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ received: true, handled: true });
  });
});

describe("the parser configuration the 'refused' test depends on", () => {
  /**
   * Why this exists, and it is not paranoia.
   *
   * `readRawBody` in `@oxyhq/crowdsource-express` prefers a Buffer on
   * `req.rawBody` before it reads the stream. So the consequence of mounting the
   * webhook LATE depends on middleware this integration does not own:
   *
   *   * plain `express.json()` — `req.body` is a parsed object, the handler
   *     REFUSES. Loud. This is Moovo today, and it is what the "mounted after"
   *     test above observes.
   *   * `express.json({ verify })` stashing the raw Buffer on `req.rawBody` — a
   *     late mount VERIFIES the parser-supplied bytes and answers **200**. Silent
   *     success, and the "mounted after" test would start failing for a reason
   *     that has nothing to do with what it is named after.
   *
   * Three apps in this ecosystem have three different behaviours here for the
   * same invariant. So the assumption is pinned explicitly rather than left
   * implicit in a test whose name does not mention it. If somebody adds a
   * `verify` to capture raw bytes for some other webhook, this fails and says
   * exactly which other test's meaning changed.
   *
   * The guard this file actually relies on — the `typeof req.body === 'undefined'`
   * probe, plus the `index.ts` ordering assertion — is independent of all of
   * this, which is why those two are the primary evidence and the refusal test
   * is corroboration.
   */
  it('uses a plain express.json with no verify hook', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');

    expect(source).toContain("app.use(express.json({ limit: '10mb' }));");
    expect(source).not.toMatch(/express\.json\(\{[^)]*verify/);
    // Nothing else may stash the raw body either, which would have the same effect.
    expect(source).not.toContain('rawBody');
  });
});

describe('index.ts mount order', () => {
  /**
   * The tests above build their own apps, so neither can notice if the REAL
   * server mounts the webhook in the wrong place. This reads the source and pins
   * the ordering there — crude, but it is the only thing that fails when somebody
   * moves the line in `index.ts`, which is exactly the regression that matters.
   */
  it('mounts the webhook router before express.json()', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');

    const webhookMount = source.indexOf("app.use('/webhooks', createCrowdSourceWebhookRoutes())");
    const jsonMount = source.indexOf('app.use(express.json(');

    expect(webhookMount).toBeGreaterThan(-1);
    expect(jsonMount).toBeGreaterThan(-1);
    expect(webhookMount).toBeLessThan(jsonMount);
  });
});

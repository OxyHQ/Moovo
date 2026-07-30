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

/**
 * Is the signature check actually LIVE?
 *
 * A different question from the raw-body one, and this file could not answer it
 * until these tests existed. Every other test here would pass with signature
 * verification deleted outright: the two acceptance tests send a valid signature
 * and only assert the delivery was handled, and the refusal test fails at
 * raw-body resolution, which happens BEFORE any signature is compared. Six green
 * tests, and none of them touched the thing that authenticates the route.
 *
 * That matters more here than almost anywhere else in the app: nothing on this
 * route is authenticated by Oxy. **The HMAC is the entire authentication.** An
 * unverified webhook endpoint lets anyone POST a decision that suspends a
 * courier.
 *
 * Credit: `alia-syra` for the question, relayed by `allo`, whose own file had
 * the same hole.
 */
describe('the HMAC is the authentication', () => {
  async function post(headers: Record<string, string>, body: string): Promise<Response> {
    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    app.use(express.json());
    const base = await listen(app);
    return await fetch(`${base}/webhooks/crowdsource`, { method: 'POST', headers, body });
  }

  it('refuses a signature minted with the wrong secret', async () => {
    const rawBody = JSON.stringify(envelope());
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const forged = createHmac('sha256', 'whsec_an_attackers_own_secret')
      .update(buildWebhookSignedPayload(timestamp, rawBody), 'utf8')
      .digest('hex');

    const response = await post(
      {
        'content-type': 'application/json',
        [WEBHOOK_EVENT_ID_HEADER]: EVENT_ID,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_VERSION}=${forged}`,
      },
      rawBody,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ rejection: 'signature_mismatch' });
    expect(recordDecisionEvent).not.toHaveBeenCalled();
  });

  it('refuses a body tampered with after signing', async () => {
    // The signature is valid — for DIFFERENT bytes. This is the attack the
    // digest exists to stop, and it is distinct from an unsigned request.
    const signedBody = JSON.stringify(envelope());
    const headers = signedHeaders(signedBody, EVENT_ID);
    const tamperedBody = signedBody.replace('"case_1"', '"case_attacker"');
    expect(tamperedBody).not.toBe(signedBody);

    const response = await post(headers, tamperedBody);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ rejection: 'signature_mismatch' });
    expect(recordDecisionEvent).not.toHaveBeenCalled();
  });

  it('refuses a replayed delivery outside the freshness window', async () => {
    // A signature valid last week is still cryptographically valid; freshness is
    // the only thing that makes a replay detectable.
    const rawBody = JSON.stringify(envelope());
    const stale = (Math.floor(Date.now() / 1_000) - 3_600).toString();
    const digest = createHmac('sha256', WEBHOOK_SECRET)
      .update(buildWebhookSignedPayload(stale, rawBody), 'utf8')
      .digest('hex');

    const response = await post(
      {
        'content-type': 'application/json',
        [WEBHOOK_EVENT_ID_HEADER]: EVENT_ID,
        [WEBHOOK_TIMESTAMP_HEADER]: stale,
        [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_VERSION}=${digest}`,
      },
      rawBody,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ rejection: 'timestamp_out_of_window' });
    expect(recordDecisionEvent).not.toHaveBeenCalled();
  });

  it('refuses a delivery carrying no signature at all', async () => {
    const rawBody = JSON.stringify(envelope());
    const response = await post(
      {
        'content-type': 'application/json',
        [WEBHOOK_EVENT_ID_HEADER]: EVENT_ID,
        [WEBHOOK_TIMESTAMP_HEADER]: Math.floor(Date.now() / 1_000).toString(),
      },
      rawBody,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ rejection: 'missing_signature' });
    expect(recordDecisionEvent).not.toHaveBeenCalled();
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

/**
 * `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`, which nothing else here exercises.
 *
 * It is plumbed from config into the middleware and was, until this test,
 * entirely unverified production code — the kind that is only ever exercised
 * during the rotation it exists for, which is the worst moment to discover it
 * was wired up wrong. A rotation with a broken previous-secret path drops every
 * decision signed with the old key, silently, on a schedule somebody chose.
 *
 * Needs its own module registry because the config mock is module-level, hence
 * `resetModules` + `doMock` + a dynamic import rather than the shared import.
 */
describe('secret rotation', () => {
  const PREVIOUS_SECRET = 'whsec_the_previous_secret';

  async function appAcceptingBothSecrets(): Promise<Express> {
    vi.resetModules();
    vi.doMock('../../config/index.js', () => ({
      config: {
        crowdSource: {
          enabled: true,
          serviceKey: 'app:cred:secret',
          baseUrl: undefined,
          webhookSecret: WEBHOOK_SECRET,
          webhookPreviousSecret: PREVIOUS_SECRET,
          outboxBatchSize: 50,
          outboxPollIntervalMs: 5_000,
          enforcementMode: 'observe',
        },
        web: { origin: 'https://moovo.now' },
      },
    }));
    const { createCrowdSourceWebhookRoutes: createRoutes } = await import(
      '../crowdsource-webhook.js'
    );
    const app = express();
    app.use('/webhooks', createRoutes());
    app.use(express.json());
    return app;
  }

  function headersSignedWith(secret: string, rawBody: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const digest = createHmac('sha256', secret)
      .update(buildWebhookSignedPayload(timestamp, rawBody), 'utf8')
      .digest('hex');
    return {
      'content-type': 'application/json',
      [WEBHOOK_EVENT_ID_HEADER]: EVENT_ID,
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_VERSION}=${digest}`,
    };
  }

  afterEach(() => {
    vi.doUnmock('../../config/index.js');
    vi.resetModules();
  });

  it('accepts a delivery signed with the PREVIOUS secret during a rotation', async () => {
    const base = await listen(await appAcceptingBothSecrets());
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: headersSignedWith(PREVIOUS_SECRET, rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    // A side-effect assertion: a 200 alone is also what an unhandled event gets.
    expect(await response.json()).toMatchObject({ received: true, handled: true });
  });

  it('still accepts the CURRENT secret while the previous one is configured', async () => {
    const base = await listen(await appAcceptingBothSecrets());
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: headersSignedWith(WEBHOOK_SECRET, rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, handled: true });
  });

  it('still refuses a THIRD secret that is neither', async () => {
    // Otherwise "accepts the previous secret" could be satisfied by accepting
    // anything, which is the failure mode a rotation window invites.
    const base = await listen(await appAcceptingBothSecrets());
    const rawBody = JSON.stringify(envelope());
    const response = await fetch(`${base}/webhooks/crowdsource`, {
      method: 'POST',
      headers: headersSignedWith('whsec_neither_of_the_two', rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ rejection: 'signature_mismatch' });
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

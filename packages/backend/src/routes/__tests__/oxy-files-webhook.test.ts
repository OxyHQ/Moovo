/**
 * Oxy's file events endpoint: where it is mounted, the challenge that verifies
 * it, and the signature every event must carry.
 *
 * Runs under vitest AND `bun test`: mock state is a plain constant and the
 * router is imported dynamically AFTER the mock (bun:test hoists neither).
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_EVENT_TYPES } from '@oxy.so/core/server';
import { OXY_FILE_EVENT_TYPES } from '../../db/schema/valueSets';
import { stubEnv, unstubAllEnvs } from '../../__tests__/fixtures/runner-compat';

const handled: unknown[] = [];

vi.mock('../../services/files/file-events.service.js', () => ({
  handleFileEvent: async (event: unknown) => {
    handled.push(event);
    return { duplicate: false, changes: [] };
  },
}));

const { createOxyFilesWebhookRoutes } = await import('../oxy-files-webhook.js');

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts');
const SECRET = 'whsec_test_secret';

function sign(body: string, secret: string, at = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

const sampleEvent = JSON.stringify({
  id: 'evt-1',
  type: 'file.blocked',
  occurredAt: new Date().toISOString(),
  file: { id: 'file-1', ownerKind: 'account', visibility: 'public', status: 'blocked' },
  references: [{ entityType: 'listing', entityId: 'l-1' }],
});

async function post(
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/webhooks', createOxyFilesWebhookRoutes());
  // A JSON parser AFTER the router, as in `index.ts`: it must never see this path.
  app.use(express.json());
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/oxy/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  handled.length = 0;
  unstubAllEnvs();
});

describe('where the file events endpoint is mounted', () => {
  const code = readFileSync(ENTRYPOINT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('mounts BEFORE the JSON parser, so the signature covers the bytes that arrived', () => {
    const mount = code.indexOf('createOxyFilesWebhookRoutes()');
    const json = code.indexOf('express.json(');
    expect(mount).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(json);
  });
});

describe('the endpoint verification challenge', () => {
  it('is echoed before any secret exists — the secret is only issued after it', async () => {
    stubEnv('OXY_FILES_WEBHOOK_SECRET', undefined);
    const response = await post(JSON.stringify({ type: 'webhook.challenge', challenge: 'abc' }));
    expect(response).toEqual({ status: 200, body: { challenge: 'abc' } });
    expect(handled).toEqual([]);
  });
});

describe('an event', () => {
  it('is handled when signed with the configured secret', async () => {
    stubEnv('OXY_FILES_WEBHOOK_SECRET', SECRET);
    const response = await post(sampleEvent, { 'oxy-signature': sign(sampleEvent, SECRET) });
    expect(response.status).toBe(200);
    expect(handled).toEqual([JSON.parse(sampleEvent)]);
  });

  it('is handled when signed with the PREVIOUS secret, so rotating is not an outage', async () => {
    stubEnv('OXY_FILES_WEBHOOK_SECRET', 'whsec_new');
    stubEnv('OXY_FILES_WEBHOOK_SECRET_PREVIOUS', SECRET);
    const response = await post(sampleEvent, { 'oxy-signature': sign(sampleEvent, SECRET) });
    expect(response.status).toBe(200);
    expect(handled).toHaveLength(1);
  });

  it('is refused unsigned, wrongly signed, or replayed outside the window', async () => {
    stubEnv('OXY_FILES_WEBHOOK_SECRET', SECRET);
    const stale = Math.floor(Date.now() / 1000) - 3_600;
    for (const headers of [
      {},
      { 'oxy-signature': sign(sampleEvent, 'whsec_wrong') },
      { 'oxy-signature': sign(sampleEvent, SECRET, stale) },
      { 'oxy-signature': sign(`${sampleEvent} `, SECRET) },
    ]) {
      expect((await post(sampleEvent, headers)).status).toBe(401);
    }
    expect(handled).toEqual([]);
  });

  it('is answered 503 while no secret is configured, so Oxy keeps retrying', async () => {
    stubEnv('OXY_FILES_WEBHOOK_SECRET', undefined);
    stubEnv('OXY_FILES_WEBHOOK_SECRET_PREVIOUS', undefined);
    const response = await post(sampleEvent, { 'oxy-signature': sign(sampleEvent, SECRET) });
    expect(response.status).toBe(503);
    expect(handled).toEqual([]);
  });
});

describe('the event types', () => {
  it('match the SDK’s, which the receipts table CHECK is rendered from', () => {
    expect([...OXY_FILE_EVENT_TYPES].sort()).toEqual([...FILE_EVENT_TYPES].sort());
  });
});

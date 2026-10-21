/**
 * `req.ip` is the real client behind the ALB, with or without Cloudflare in
 * front of it.
 *
 * Every IP-keyed limit reads `req.ip` (the global limiter keys anonymous
 * callers on it, and `tracking-lookup` is the enumeration surface's only
 * brake). With no `trust proxy` at all `req.ip` is the ALB's private address,
 * and with `trust proxy = 1` it is Cloudflare's edge once the hostname is
 * proxied: either way every anonymous caller shares one counter.
 *
 * The app under test sets the same `trust proxy` the server does and the test
 * server listens on loopback, which plays the ALB (a private socket peer).
 * The source pin below is what fails if `index.ts` stops setting it, or sets
 * it after a middleware that already read `req.ip`.
 */

import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oxyTrustProxy } from '@oxy.so/core/server';
import express from 'express';
import { describe, expect, it } from 'vitest';

const CLIENT = '203.0.113.7';
const CLOUDFLARE_EDGE = '172.70.1.2';

async function ipSeenFor(forwardedFor: string): Promise<string | undefined> {
  const instance = express();
  instance.set('trust proxy', oxyTrustProxy);
  instance.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });

  const server: Server = await new Promise((resolve) => {
    const listener = instance.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test server did not bind to a port');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/ip`, {
      headers: { 'X-Forwarded-For': forwardedFor },
    });
    const body = (await response.json()) as { ip?: string };
    return body.ip;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('req.ip behind the proxy chain', () => {
  it('is the client on a DNS-only hostname (the ALB appended the client)', async () => {
    expect(await ipSeenFor(CLIENT)).toBe(CLIENT);
  });

  it('is the client, not the Cloudflare edge, on a proxied hostname', async () => {
    expect(await ipSeenFor(`${CLIENT}, ${CLOUDFLARE_EDGE}`)).toBe(CLIENT);
  });

  it('ignores an address the caller wrote into the header itself', async () => {
    expect(await ipSeenFor(`198.51.100.1, ${CLIENT}`)).toBe(CLIENT);
  });
});

describe('index.ts', () => {
  it('sets trust proxy to oxyTrustProxy before any middleware runs', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'index.ts'), 'utf8');

    const trustProxy = source.indexOf("app.set('trust proxy', oxyTrustProxy);");
    const firstMiddleware = source.indexOf('app.use(');

    expect(trustProxy).toBeGreaterThan(-1);
    expect(firstMiddleware).toBeGreaterThan(-1);
    expect(trustProxy).toBeLessThan(firstMiddleware);
  });
});

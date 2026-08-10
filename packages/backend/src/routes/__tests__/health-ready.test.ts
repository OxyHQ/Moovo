/**
 * The readiness probe, which is what decides whether a task receives traffic.
 *
 * This file was written around one case, `does NOT require Mongo once Mongo is
 * unconfigured`, which tested a state that did not exist in production yet.
 * It has since been reached and passed: production answered `not_configured`
 * for the whole window between the cutover and this cut, so the Mongo-removal
 * deploy never had a health check to fail. That case has now gone with the
 * store it guarded — what is left is the property it was protecting, that
 * readiness tracks the store the service ACTUALLY reads and nothing else.
 *
 * The Postgres probe is mocked at `db/postgres` rather than run against a real
 * server: what is under test is the DECISION the handler makes from a probe's
 * outcome, and a real server can only ever produce the success half of it. The
 * probe's own `select 1` is exercised for real by every other realdb suite that
 * opens a connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// `vi.mock` factories are hoisted above every `const`, so the state they close
// over has to be hoisted with them.
const { postgresQuery } = vi.hoisted(() => ({
  postgresQuery: vi.fn(),
}));

vi.mock('../../db/postgres.js', () => ({
  // `getClient()` returns a tagged-template function, so the mock has to be one.
  getClient: () => (...args: unknown[]) => postgresQuery(...args),
}));

vi.mock('../../lib/redis.js', () => ({ getRedisClient: () => null }));

import healthRouter from '../health.js';

/**
 * Drive the router over a REAL ephemeral listener.
 *
 * No `supertest` — adding a dependency for one suite would put a lockfile
 * change in a PR whose whole point is to be small and land ahead of a cutover.
 * A real socket also exercises the actual express stack, which is what the load
 * balancer talks to.
 */
async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const instance = express();
  instance.use('/health', healthRouter);

  const server: Server = await new Promise((resolve) => {
    const listener = instance.listen(0, () => resolve(listener));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test server did not bind to a port');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  postgresQuery.mockReset().mockResolvedValue([{ '?column?': 1 }]);
});

describe('GET /health/ready', () => {
  it('is ready when Postgres answers', async () => {
    const response = await get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      postgres: 'connected',
    });
    // The Postgres half is a REAL query, not an inference from configuration.
    expect(postgresQuery).toHaveBeenCalledTimes(1);
  });

  /**
   * Readiness must track ONLY the stores the service reads.
   *
   * Mongo is gone, so a residual mention of it in a readiness response would be
   * a dependency this service does not have — and the shape of the bug that
   * makes a probe outlive its store is precisely a key nobody removed.
   */
  it('names no store other than Postgres', async () => {
    const response = await get('/health/ready');

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['postgres', 'status']);
  });

  /**
   * The other direction, which the old probe could not see at all: Postgres
   * down read as `ready` while every request returned 500.
   */
  it('is NOT ready when Postgres cannot answer', async () => {
    postgresQuery.mockRejectedValue(new Error('connection refused'));

    const response = await get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      reason: 'postgres_unavailable',
      postgres: 'unavailable',
    });
  });

  it('is NOT ready when Postgres hangs, rather than hanging itself', async () => {
    // A probe that never answers gives the load balancer nothing to act on.
    postgresQuery.mockImplementation(() => new Promise(() => {}));

    const response = await get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ reason: 'postgres_unavailable' });
  }, 10_000);

  it('is NOT ready when Postgres is not configured at all', async () => {
    // `getClient()` throws without DATABASE_URL; answering 200 on an unexpected
    // error is precisely the failure this endpoint exists to prevent.
    postgresQuery.mockImplementation(() => {
      throw new Error('DATABASE_URL is not set, so this service has no database to open.');
    });

    const response = await get('/health/ready');
    expect(response.status).toBe(503);
  });
});

describe('GET /health/live', () => {
  it('stays alive while every dependency is down', async () => {
    // Liveness must not depend on a database: a blip should never get a
    // container killed and restarted, only taken out of rotation.
    postgresQuery.mockRejectedValue(new Error('connection refused'));

    const response = await get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'alive' });
  });
});

describe('GET /health', () => {
  it('is unhealthy when Postgres is down', async () => {
    postgresQuery.mockRejectedValue(new Error('connection refused'));

    const response = await get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'degraded', postgres: 'unavailable' });
  });
});

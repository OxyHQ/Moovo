/**
 * The readiness probe, which is what decides whether a task receives traffic.
 *
 * The case that matters most is `does NOT require Mongo once Mongo is
 * unconfigured` — it is the whole reason this change exists, and it is a test of
 * a state that does not exist yet in production. Without it the Mongo-removal
 * deploy fails every ALB health check within ~90 seconds and ECS replaces the
 * tasks in a loop, while the build, the migration and the rollout all report
 * success. Nothing else in the suite would notice.
 *
 * The Postgres probe is mocked at `db/postgres` rather than run against a real
 * server: what is under test is the DECISION the handler makes from a probe's
 * outcome, and a real server can only ever produce the success half of it. The
 * probe's own `select 1` is exercised for real by every other realdb suite that
 * opens a connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// `vi.mock` factories are hoisted above every `const`, so the state they close
// over has to be hoisted with them.
const { postgresQuery, mongooseState } = vi.hoisted(() => ({
  postgresQuery: vi.fn(),
  mongooseState: { readyState: 1 },
}));

vi.mock('../../db/postgres.js', () => ({
  // `getClient()` returns a tagged-template function, so the mock has to be one.
  getClient: () => (...args: unknown[]) => postgresQuery(...args),
}));

vi.mock('../../lib/redis.js', () => ({ getRedisClient: () => null }));

vi.mock('mongoose', () => ({ default: { connection: mongooseState } }));

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

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;

beforeEach(() => {
  postgresQuery.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  mongooseState.readyState = 1;
  process.env.MONGODB_URI = 'mongodb://localhost:27017/moovo';
});

afterEach(() => {
  if (ORIGINAL_MONGODB_URI === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
});

describe('GET /health/ready', () => {
  it('is ready when both configured stores answer', async () => {
    const response = await get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      postgres: 'connected',
      mongodb: 'connected',
    });
    // The Postgres half is a REAL query, not an inference from configuration.
    expect(postgresQuery).toHaveBeenCalledTimes(1);
  });

  /**
   * The case this whole change exists for.
   *
   * On the deploy that removes Mongo, `MONGODB_URI` leaves the task definition
   * and `mongoose.connection.readyState` is 0 forever. The previous handler
   * returned 503 on exactly that, so every task would fail the ALB check within
   * ~90 seconds and be replaced in a loop — with a green deploy.
   */
  it('does NOT require Mongo once Mongo is unconfigured', async () => {
    delete process.env.MONGODB_URI;
    mongooseState.readyState = 0;

    const response = await get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', mongodb: 'not_configured' });
  });

  it('is NOT ready when Mongo is configured but disconnected', async () => {
    mongooseState.readyState = 0;

    const response = await get('/health/ready');

    expect(response.status).toBe(503);
    // The reason NAMES the store: `database_unavailable` was true of both and
    // identified neither.
    expect(response.body).toMatchObject({
      status: 'not_ready',
      reason: 'mongodb_unavailable',
      postgres: 'connected',
    });
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
    mongooseState.readyState = 0;

    const response = await get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'alive' });
  });
});

describe('GET /health', () => {
  it('reports Postgres alongside Mongo, and is unhealthy when Postgres is down', async () => {
    postgresQuery.mockRejectedValue(new Error('connection refused'));

    const response = await get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'degraded', postgres: 'unavailable' });
  });
});

/**
 * Liveness and readiness.
 *
 * ## The readiness probe is what the load balancer actually asks
 *
 * The `oxy-moovo` target group health-checks `/health/ready` (matcher 200, 30s
 * interval, unhealthy threshold 3), so this handler decides whether a task
 * receives traffic at all. Two properties follow from that and are the reason
 * this file is shaped the way it is:
 *
 *  - **It must not depend on a store the service is in the middle of leaving.**
 *    It previously returned 503 unless `mongoose.connection.readyState === 1`.
 *    That is fine today and catastrophic on the deploy that removes Mongo: every
 *    task would fail the check within ~90s and ECS would replace them in a loop,
 *    while the build, the migration and the rollout all reported success. The
 *    Mongo half is therefore REQUIRED only while Mongo is configured, so it
 *    stops being required on the deploy that stops configuring it — no code
 *    change has to be timed with that rollout.
 *  - **It must actually ask the store the service reads.** A probe naming one
 *    database and checking only that one is wrong in both directions: before
 *    this change a Postgres outage read as `ready` while every request failed.
 *    So Postgres is asked a real question (`select 1`) rather than inferred from
 *    a connection string.
 *
 * **Failure semantics, stated deliberately:** with threshold 3 at a 30s
 * interval, a Postgres outage lasting ~90s takes tasks out of service. That is
 * correct for a READINESS probe — a task that cannot reach its only database
 * cannot serve — and it is a decision rather than an accident. `/health/live`
 * deliberately checks NOTHING but the process, so a database blip never gets a
 * container killed and restarted.
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../lib/redis.js';
import { getClient } from '../db/postgres.js';
import { mongoIsConfigured } from '../lib/db.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * How long a dependency probe may take before it counts as unreachable.
 *
 * Shorter than the ALB's own check interval on purpose: a probe that hangs
 * gives the load balancer nothing to act on and ties up a connection per check.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** The outcome of one dependency probe. */
interface ProbeResult {
  ok: boolean;
  detail: string;
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out`)), PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask Postgres a real question.
 *
 * `select 1` rather than a query against a table: it costs nothing, and a probe
 * that depends on a particular row or table existing starts failing for reasons
 * that have nothing to do with reachability — a truncated fixture, a migration
 * mid-flight — which is how a readiness probe becomes something people ignore.
 */
async function probePostgres(): Promise<ProbeResult> {
  try {
    await withTimeout(getClient()`select 1`, 'postgres');
    return { ok: true, detail: 'connected' };
  } catch (error: unknown) {
    log.general.warn({ err: error }, 'Readiness: Postgres probe failed');
    return { ok: false, detail: 'unavailable' };
  }
}

/** Mongo's own readiness — required only while Mongo is configured. */
function probeMongo(): ProbeResult {
  if (!mongoIsConfigured()) {
    return { ok: true, detail: 'not_configured' };
  }
  return mongoose.connection.readyState === 1
    ? { ok: true, detail: 'connected' }
    : { ok: false, detail: 'unavailable' };
}

// ============== HEALTH STATE CACHE ==============
// Avoid recomputing the snapshot on every probe.

interface HealthSnapshot {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  mongodb: 'connected' | 'connecting' | 'disconnecting' | 'disconnected' | 'not_configured';
  postgres: 'connected' | 'unavailable';
  redis: 'connected' | 'unavailable';
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

let healthCache: { data: HealthSnapshot; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

async function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const mongoState = mongoose.connection.readyState;
  const mongoStatus: HealthSnapshot['mongodb'] = !mongoIsConfigured()
    ? 'not_configured'
    : mongoState === 1 ? 'connected'
    : mongoState === 2 ? 'connecting'
    : mongoState === 3 ? 'disconnecting'
    : 'disconnected';
  const postgres = await probePostgres();

  const mem = process.memoryUsage();
  const redis = getRedisClient();
  const redisStatus = redis ? 'connected' : 'unavailable';

  /**
   * Healthy means every store this deployment depends on can answer.
   *
   * Gating this on Mongo ALONE — which it did — is wrong in both directions:
   * it reports unhealthy the moment Mongo is retired, and it reported healthy
   * throughout a Postgres outage while every request failed.
   */
  const isHealthy = postgres.ok && (mongoStatus === 'not_configured' || mongoStatus === 'connected');

  const snapshot: HealthSnapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    mongodb: mongoStatus,
    postgres: postgres.ok ? 'connected' : 'unavailable',
    redis: redisStatus,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot();
    const statusCode = snapshot.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(snapshot);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }
});

// Liveness probe: process is running -> 200
// Used by k8s/DO App Platform to detect crashed processes
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness: every store this deployment actually depends on can answer.
 *
 * The response NAMES each dependency, so an operator reading a 503 knows which
 * one is down rather than re-deriving it — `database_unavailable` was true of
 * both and identified neither.
 */
router.get('/ready', async (_req, res) => {
  try {
    const [postgres, mongodb] = [await probePostgres(), probeMongo()];
    const ready = postgres.ok && mongodb.ok;

    if (!ready) {
      return res.status(503).json({
        status: 'not_ready',
        reason: postgres.ok ? 'mongodb_unavailable' : 'postgres_unavailable',
        postgres: postgres.detail,
        mongodb: mongodb.detail,
      });
    }
    res.status(200).json({ status: 'ready', postgres: postgres.detail, mongodb: mongodb.detail });
  } catch (error: unknown) {
    // A probe that throws is NOT ready. Answering 200 on an unexpected error
    // would be the failure this endpoint exists to prevent.
    log.general.error({ err: error }, 'Readiness probe failed unexpectedly');
    res.status(503).json({ status: 'not_ready', reason: 'probe_failed' });
  }
});

export default router;

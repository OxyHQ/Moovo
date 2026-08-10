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
 *    It once returned 503 unless `mongoose.connection.readyState === 1`, which
 *    would have been catastrophic on the deploy that removed Mongo: every task
 *    would have failed the check within ~90s and ECS would have replaced them
 *    in a loop, while the build, the migration and the rollout all reported
 *    success. Making the Mongo half conditional on Mongo being CONFIGURED is
 *    what let that deploy land without timing a code change against it — by
 *    the time Mongo was deleted this probe had already stopped asking, and
 *    production was answering `mongodb: not_configured`. The conditional has
 *    now gone the same way as the store it guarded.
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
import { getRedisClient } from '../lib/redis.js';
import { getClient } from '../db/postgres.js';
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

// ============== HEALTH STATE CACHE ==============
// Avoid recomputing the snapshot on every probe.

interface HealthSnapshot {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
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

  const postgres = await probePostgres();

  const mem = process.memoryUsage();
  const redis = getRedisClient();
  const redisStatus = redis ? 'connected' : 'unavailable';

  /**
   * Healthy means every store this deployment depends on can answer.
   *
   * This once gated on Mongo ALONE, which was wrong in both directions: it
   * would have reported unhealthy the moment Mongo was retired, and it
   * reported healthy throughout a Postgres outage while every request failed.
   * Postgres is now the only store, so it is the whole answer.
   */
  const isHealthy = postgres.ok;

  const snapshot: HealthSnapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
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
 * The response NAMES the dependency rather than saying `database_unavailable`,
 * which was true of both stores back when there were two and identified
 * neither. Postgres is the only one left, so the reason code is specific by
 * construction today — the naming convention is kept because the next store
 * this service takes on must not reintroduce the ambiguity.
 */
router.get('/ready', async (_req, res) => {
  try {
    const postgres = await probePostgres();

    if (!postgres.ok) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'postgres_unavailable',
        postgres: postgres.detail,
      });
    }
    res.status(200).json({ status: 'ready', postgres: postgres.detail });
  } catch (error: unknown) {
    // A probe that throws is NOT ready. Answering 200 on an unexpected error
    // would be the failure this endpoint exists to prevent.
    log.general.error({ err: error }, 'Readiness probe failed unexpectedly');
    res.status(503).json({ status: 'not_ready', reason: 'probe_failed' });
  }
});

export default router;

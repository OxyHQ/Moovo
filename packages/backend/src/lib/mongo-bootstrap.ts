/**
 * Attaching to Mongo at start-up, WITHOUT letting it decide whether the server
 * starts.
 *
 * This lives in its own module rather than inside `index.ts` so the policy can
 * be tested directly: `index.ts` binds a port and starts dispatchers at import,
 * so anything defined there can only be asserted about indirectly.
 *
 * ## Why it exists
 *
 * The server used to start inside `connectDB().then(...)`, with a `.catch` that
 * called `process.exit(1)`. Every courier domain now runs on PostgreSQL, so that
 * made an optional store decide whether the HTTP listener existed at all. With
 * Mongo retired, `connectDB()` rejected after its 10s server-selection timeout
 * and the process exited before `server.listen` — measured, `node dist/index.js`
 * with no `MONGODB_URI`:
 *
 *     "Connecting to MongoDB..."                       t+0s
 *     MongooseServerSelectionError: ECONNREFUSED …:27017  t+10s
 *     "Failed to connect to MongoDB" -> exit(1)
 *     GET /health/ready -> nothing listening
 *
 * So `/health/ready` could not report anything, however correct the probe
 * itself is, and ECS saw an unexplained crash loop.
 *
 * ## The two properties this module guarantees
 *
 * 1. **An UNCONFIGURED Mongo is not an error.** It resolves without dialling
 *    anything. Note the discriminator is whether the environment supplies a URI
 *    — `connectDB` used to default it to localhost, which is why removing the
 *    secret from a task definition did not disable Mongo but repointed it at a
 *    host inside the container where nothing answers.
 * 2. **A CONFIGURED-but-unreachable Mongo is not fatal either.** It resolves,
 *    having logged. The readiness probe already answers that case with
 *    `mongodb_unavailable`, which takes the task out of service while leaving it
 *    able to say why; exiting replaces a diagnosable 503 with a crash loop.
 *
 * Both are the same underlying rule: **this function never rejects**, so the
 * start-up block that follows it always runs. That matters beyond the listener
 * — the external provider adapters and `seedProviders()` run in that block, and
 * `seedProviders` writes through `db/transport/providerRepository` to Postgres,
 * so gating it behind a Mongo connection would silently stop external carrier
 * quotes from surfacing.
 */

import { connectDB, mongoIsConfigured } from './db.js';
import { log } from './logger.js';

export async function bootstrapMongo(): Promise<void> {
  if (!mongoIsConfigured()) {
    log.general.info('MONGODB_URI not set — starting without MongoDB');
    return;
  }
  try {
    await connectDB();
  } catch (err: unknown) {
    log.general.error({ err }, 'MongoDB connection failed — readiness will report it');
  }
}

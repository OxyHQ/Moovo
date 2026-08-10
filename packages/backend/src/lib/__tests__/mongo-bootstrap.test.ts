/**
 * Boot must not depend on Mongo.
 *
 * This is a test of a state that did not exist until Mongo was retired, and
 * nothing else in the suite would notice it breaking: the failure mode is the
 * process exiting BEFORE `server.listen`, so there is no request to assert on
 * and no handler to reach. `/health/ready` being correct does not help — it was
 * already correct, and unreachable behind the gate.
 *
 * Two layers, because they fail for different reasons. The behavioural cases
 * pin what `bootstrapMongo` does; the scanned case pins that `index.ts` still
 * routes through it, which is the edit a future change would undo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { connect, connection } = vi.hoisted(() => ({
  connect: vi.fn(),
  connection: { readyState: 0, on: vi.fn() },
}));

vi.mock('mongoose', () => ({ default: { connect, connection } }));

import { bootstrapMongo } from '../mongo-bootstrap.js';

const ORIGINAL = process.env.MONGODB_URI;

beforeEach(() => {
  connect.mockReset().mockResolvedValue({});
  connection.readyState = 0;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = ORIGINAL;
});

describe('bootstrapMongo', () => {
  it('resolves and dials NOTHING when Mongo is unconfigured', async () => {
    delete process.env.MONGODB_URI;

    await expect(bootstrapMongo()).resolves.toBeUndefined();

    // The assertion that matters: not merely that it resolved, but that no
    // connection was attempted. `connectDB` used to default the URI to
    // localhost, so "unconfigured" still dialled a host inside the container
    // and burned the 10s server-selection timeout before exiting.
    expect(connect).not.toHaveBeenCalled();
  });

  it('resolves rather than rejecting when a CONFIGURED Mongo is unreachable', async () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/moovo';
    connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:27017'));

    // Rejecting here is what killed the process before the listener existed.
    // Readiness reports `mongodb_unavailable` instead, which takes the task out
    // of service while leaving it able to say why.
    await expect(bootstrapMongo()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('still connects when Mongo IS configured and reachable', async () => {
    process.env.MONGODB_URI = 'mongodb://mongo.internal:27017/moovo';

    await bootstrapMongo();

    // A deployment that still carries the secret must behave exactly as before.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toBe('mongodb://mongo.internal:27017/moovo');
  });
});

describe('index.ts start-up wiring', () => {
  const indexPath = path.join(__dirname, '..', '..', 'index.ts');
  const source = readFileSync(indexPath, 'utf8');

  it('reads an index.ts that actually starts a server (vacuity floor)', () => {
    // Without this, every assertion below passes just as well against an empty
    // string or a path that stopped resolving.
    expect(source.length).toBeGreaterThan(2_000);
    expect(source).toContain('server.listen(');
  });

  it('starts the server through bootstrapMongo, not through connectDB', () => {
    expect(source).toContain('bootstrapMongo()');

    // `connectDB` must be reached ONLY via bootstrapMongo. Its reappearance
    // here is precisely how the gate would come back: the tempting shape is
    // `connectDB().then(() => server.listen(...))`, which type-checks, passes
    // every other test, and exits 1 in production ten seconds after start-up.
    expect(source).not.toContain('connectDB');
  });
});

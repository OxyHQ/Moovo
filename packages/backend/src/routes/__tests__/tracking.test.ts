/**
 * The tracking HTTP surface: who may call what, and what a refusal says.
 *
 * The service is mocked here on purpose. Every WRITE this surface performs goes
 * through `services/tracking/tracking.service.ts`, which has its own realdb
 * suite — so what is left to test is the routing, the auth posture and the
 * shape of a refusal, none of which needs a database.
 *
 * The case worth naming: **another user's parcel must come back 404, not 403.**
 * A 403 confirms the row exists, which turns an id somebody guessed into an
 * oracle. The service enforces it by scoping every read with an owner predicate
 * in the WHERE rather than checking after the read; this pins that the surface
 * does not undo it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { service, currentUserId } = vi.hoisted(() => ({
  service: {
    listCarriers: vi.fn(),
    detectCarriersForNumber: vi.fn(),
    lookupParcel: vi.fn(),
    listParcels: vi.fn(),
    trackParcel: vi.fn(),
    getParcelDetail: vi.fn(),
    updateParcel: vi.fn(),
    untrackParcel: vi.fn(),
    requestRefresh: vi.fn(),
  },
  currentUserId: { value: null as string | null },
}));

vi.mock('../../services/tracking/tracking.service.js', () => service);

// `optionalAuth` is a no-op here; the posture under test is what the CONTROLLER
// does when there is no user, which is what `getRequiredOxyUserId` decides.
vi.mock('../../middleware/auth.js', () => ({
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  oxyClient: {},
}));

vi.mock('@oxy.so/core/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRequiredOxyUserId: () => {
      if (currentUserId.value === null) {
        const error = new Error('Unauthorized');
        (error as { statusCode?: number }).statusCode = 401;
        throw error;
      }
      return currentUserId.value;
    },
  };
});

vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { notFound, conflict } = await import('../../lib/errors/error-codes.js');
const trackingRouter = (await import('../tracking.js')).default;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const instance = express();
  instance.use(express.json());
  instance.use('/tracking', trackingRouter);

  const server: Server = await new Promise((resolve) => {
    const listener = instance.listen(0, () => resolve(listener));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test server did not bind to a port');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  currentUserId.value = 'oxy-ana';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the anonymous surface', () => {
  it('answers a lookup with no user at all', async () => {
    // The product, not a concession: paste a number, see the parcel, owe us
    // nothing.
    currentUserId.value = null;
    service.lookupParcel.mockResolvedValue({ status: 'in_transit' });

    const response = await call('POST', '/tracking/lookup', { number: '1Z999AA10123456784' });
    expect(response.status).toBe(200);
    expect(service.lookupParcel).toHaveBeenCalledTimes(1);
  });

  it('answers detection and the catalogue with no user', async () => {
    currentUserId.value = null;
    service.detectCarriersForNumber.mockResolvedValue({ carrierKey: 'ups', candidates: [] });
    service.listCarriers.mockResolvedValue([]);

    expect((await call('POST', '/tracking/detect', { number: '1Z999AA10123456784' })).status).toBe(
      200,
    );
    expect((await call('GET', '/tracking/carriers')).status).toBe(200);
  });

  it('refuses a number too short to be one, before reaching the service', async () => {
    currentUserId.value = null;
    const response = await call('POST', '/tracking/lookup', { number: 'ab' });
    expect(response.status).toBe(400);
    expect(service.lookupParcel).not.toHaveBeenCalled();
  });
});

describe('the owned surface', () => {
  it('refuses a list with no user', async () => {
    currentUserId.value = null;
    const response = await call('GET', '/tracking/parcels');
    expect(response.status).toBe(401);
    expect(service.listParcels).not.toHaveBeenCalled();
  });

  it("returns 404 — not 403 — for another user's parcel", async () => {
    // A 403 would confirm the row exists and turn a guessed id into an oracle.
    service.getParcelDetail.mockRejectedValue(notFound('Parcel not found'));
    const response = await call('GET', '/tracking/parcels/019400000000000000000000');
    expect(response.status).toBe(404);
  });

  it('passes the caller through to the service rather than trusting the body', async () => {
    service.trackParcel.mockResolvedValue({ id: 'sub-1' });
    await call('POST', '/tracking/parcels', {
      number: '1Z999AA10123456784',
      oxyUserId: 'oxy-someone-else',
    });
    expect(service.trackParcel).toHaveBeenCalledWith(
      'oxy-ana',
      expect.objectContaining({ number: '1Z999AA10123456784' }),
    );
  });

  it('refuses an empty PATCH rather than answering 200 and changing nothing', async () => {
    const response = await call('PATCH', '/tracking/parcels/019400000000000000000000', {});
    expect(response.status).toBe(400);
    expect(service.updateParcel).not.toHaveBeenCalled();
  });

  it('accepts a carrier correction, which re-points rather than mutates', async () => {
    service.updateParcel.mockResolvedValue({ id: 'sub-1' });
    const response = await call('PATCH', '/tracking/parcels/019400000000000000000000', {
      carrierKey: 'correos',
    });
    expect(response.status).toBe(200);
    expect(service.updateParcel).toHaveBeenCalledWith(
      '019400000000000000000000',
      'oxy-ana',
      expect.objectContaining({ carrierKey: 'correos' }),
    );
  });

  it('queues a refresh with 202 rather than calling the carrier inline', async () => {
    // A request thread must not hold a carrier's timeout open; one slow carrier
    // would otherwise exhaust the connection pool.
    service.requestRefresh.mockResolvedValue(undefined);
    const response = await call('POST', '/tracking/parcels/019400000000000000000000/refresh');
    expect(response.status).toBe(202);
  });

  it('reports the refresh cooldown as a conflict', async () => {
    service.requestRefresh.mockRejectedValue(conflict('checked moments ago'));
    const response = await call('POST', '/tracking/parcels/019400000000000000000000/refresh');
    expect(response.status).toBe(409);
  });

  it('rejects an id that is not an entity id before the service sees it', async () => {
    const response = await call('GET', '/tracking/parcels/not-an-id');
    expect(response.status).toBe(400);
    expect(service.getParcelDetail).not.toHaveBeenCalled();
  });
});

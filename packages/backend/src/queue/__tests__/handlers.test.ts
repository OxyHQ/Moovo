/**
 * Unit tests for the marketplace job handlers.
 *
 * Focus: `handleExpireReservations` transitions whatever the repository's
 * working-set query returns, and is a no-op when nothing is stale. The date cut
 * itself is a WHERE clause and belongs to the repository — it is asserted
 * against a real server in `db/commerce/__tests__/orders.realdb.test.ts`,
 * because a mock returning a list proves nothing about which rows Postgres
 * would have selected.
 *
 * What is left here is the handler's OWN contract: one transition per stale
 * order, and a per-order failure that does not abort the sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findStaleUnpaidOrders = vi.fn();
const transition = vi.fn();

vi.mock('../../db/commerce/orderRepository.js', () => ({
  findOrderById: vi.fn(),
  findStaleUnpaidOrders: (...args: unknown[]) => findStaleUnpaidOrders(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({ findStoreById: vi.fn() }));
vi.mock('../../models/listing.js', () => ({ Listing: { findById: vi.fn() } }));
vi.mock('../../models/review.js', () => ({ Review: { aggregate: vi.fn() } }));

vi.mock('../../services/order.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
}));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

import { handleExpireReservations } from '../handlers.js';

beforeEach(() => {
  vi.clearAllMocks();
  transition.mockResolvedValue(undefined);
});

describe('handleExpireReservations', () => {
  it('cancels each stale pending_payment order via transition', async () => {
    const stale = { order: { id: 'order-old-1', status: 'pending_payment' }, items: [], statusHistory: [] };
    findStaleUnpaidOrders.mockResolvedValue([stale]);

    await handleExpireReservations();

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      stale,
      'cancelled',
      expect.objectContaining({ note: 'reservation expired' }),
    );
  });

  it('passes a cutoff in the past, never a future one', async () => {
    findStaleUnpaidOrders.mockResolvedValue([]);

    await handleExpireReservations();

    const cutoff = findStaleUnpaidOrders.mock.calls[0][0] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does nothing when no orders are stale', async () => {
    findStaleUnpaidOrders.mockResolvedValue([]);

    await handleExpireReservations();

    expect(transition).not.toHaveBeenCalled();
  });

  it('continues past a per-order transition failure', async () => {
    const a = { order: { id: 'order-a', status: 'pending_payment' }, items: [], statusHistory: [] };
    const b = { order: { id: 'order-b', status: 'pending_payment' }, items: [], statusHistory: [] };
    findStaleUnpaidOrders.mockResolvedValue([a, b]);
    transition.mockRejectedValueOnce(new Error('cannot cancel'));

    await expect(handleExpireReservations()).resolves.toBeUndefined();

    expect(transition).toHaveBeenCalledTimes(2);
  });
});

/**
 * The outbox coupling: a delivery event may only be written inside a
 * transaction.
 *
 * This is the invariant that keeps "the reporter got a 201" and "somebody will
 * actually deliver this" from coming apart. It is enforced at runtime rather than
 * by review because the mistake it catches — passing a session nobody opened a
 * transaction on — type-checks perfectly, commits the row on its own, and passes
 * any test that only asserts the row exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClientSession } from 'mongoose';

const updateOne = vi.fn();

vi.mock('../../../models/moderation-outbox.js', () => ({
  ModerationOutbox: { updateOne: (...args: unknown[]) => updateOne(...args) },
  MODERATION_OUTBOX_RETENTION_SECONDS: 2_592_000,
  MODERATION_OUTBOX_KINDS: ['report.submit', 'decision.apply'],
}));

vi.mock('../../../lib/logger.js', () => ({
  log: { moderation: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import {
  enqueueModerationOutboxEvent,
  ModerationOutboxTransactionError,
  isRetryableDeliveryError,
  reportSubmitEventId,
  decisionApplyEventId,
} from '../moderation-outbox.service.js';

/**
 * A session that answers whether it is in a transaction, and nothing else.
 *
 * Deliberately not a mongoose `ClientSession` mock with every method stubbed: the
 * only thing the guard consults is `inTransaction()`, and a fatter double would
 * invite a future test to assert against behaviour the real session owns.
 */
function sessionInTransaction(open: boolean): ClientSession {
  const session = { inTransaction: () => open };
  return session as unknown as ClientSession;
}

const EVENT = {
  eventId: 'moderation:report.submit:report-1',
  kind: 'report.submit' as const,
  payload: { reportId: 'report-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  updateOne.mockResolvedValue({ upsertedCount: 1 });
});

describe('enqueueModerationOutboxEvent', () => {
  it('writes the row when the session is in a transaction', async () => {
    const eventId = await enqueueModerationOutboxEvent(EVENT, sessionInTransaction(true));

    expect(eventId).toBe(EVENT.eventId);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, , options] = updateOne.mock.calls[0] as [unknown, unknown, { upsert: boolean }];
    expect(options.upsert).toBe(true);
  });

  /**
   * The mutation this file exists for.
   *
   * Remove the `inTransaction()` guard from `enqueueModerationOutboxEvent` and
   * this is the assertion that goes red — and it goes red naming the exact
   * failure, because the error message is the documentation of why the guard is
   * there. Verified by actually deleting the guard, not by assuming.
   */
  it('REFUSES to write outside a transaction', async () => {
    await expect(
      enqueueModerationOutboxEvent(EVENT, sessionInTransaction(false)),
    ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
  });

  it('writes nothing at all when it refuses', async () => {
    // A guard that threw AFTER writing would still leave the uncoupled row it
    // exists to prevent, so the refusal and the absence of a write are two
    // different claims and both are asserted.
    await expect(
      enqueueModerationOutboxEvent(EVENT, sessionInTransaction(false)),
    ).rejects.toThrow();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('names the consequence, not just the rule', async () => {
    await expect(
      enqueueModerationOutboxEvent(EVENT, sessionInTransaction(false)),
    ).rejects.toThrow(/answered 201 and never delivered/);
  });

  it('upserts on a deterministic id so a retry cannot queue two deliveries', async () => {
    await enqueueModerationOutboxEvent(EVENT, sessionInTransaction(true));
    await enqueueModerationOutboxEvent(EVENT, sessionInTransaction(true));

    const filters = updateOne.mock.calls.map((call) => call[0]);
    expect(filters[0]).toEqual({ _id: EVENT.eventId });
    expect(filters[1]).toEqual(filters[0]);
  });

  it('sets the row body only on insert, so a retry never resets attempts', async () => {
    await enqueueModerationOutboxEvent(EVENT, sessionInTransaction(true));
    const [, update] = updateOne.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(update).toHaveProperty('$setOnInsert');
    expect(update).not.toHaveProperty('$set');
  });
});

describe('event ids', () => {
  it('derives a report event id from the report, not the request', () => {
    expect(reportSubmitEventId('abc')).toBe('moderation:report.submit:abc');
    expect(reportSubmitEventId('abc')).toBe(reportSubmitEventId('abc'));
  });

  it('derives a decision event id from the webhook event id', () => {
    expect(decisionApplyEventId('evt_1')).toBe('moderation:decision.apply:evt_1');
  });
});

describe('isRetryableDeliveryError', () => {
  it('obeys an explicit retryable:false', () => {
    expect(isRetryableDeliveryError({ retryable: false })).toBe(false);
  });

  it('obeys an explicit retryable:true', () => {
    expect(isRetryableDeliveryError({ retryable: true })).toBe(true);
  });

  it('treats anything else as retryable', () => {
    // Assuming a defect is permanent is how a recoverable outage becomes lost
    // moderation work, so the default has to lean the other way.
    expect(isRetryableDeliveryError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableDeliveryError(undefined)).toBe(true);
    expect(isRetryableDeliveryError({ retryable: 'no' })).toBe(true);
  });
});

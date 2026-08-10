/**
 * The outbox POLICY: event ids, and where retrying stops.
 *
 * What this file used to hold — the assertion that a delivery event may only be
 * written inside a transaction — has MOVED to `moderation.realdb.test.ts`, and
 * that is a strengthening rather than a relocation. It was asserted here against
 * a hand-made session object whose `inTransaction()` returned whatever the test
 * said, so it proved the guard consulted its argument and nothing about whether
 * a REAL handle answers correctly. The Postgres guard discriminates on whether
 * the handle carries `.rollback`, and the only thing that can establish that
 * `getDb()` lacks it while a real `db.transaction(...)` handle has it is a real
 * server.
 *
 * What remains here is what genuinely has no database in it: the event ids, and
 * the retryability rule that decides whether a failure is worth another attempt.
 */

import { describe, it, expect } from 'vitest';

import {
  isRetryableDeliveryError,
  reportSubmitEventId,
  decisionApplyEventId,
} from '../moderation-outbox.service.js';

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

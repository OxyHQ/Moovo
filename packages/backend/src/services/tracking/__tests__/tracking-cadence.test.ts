/**
 * The cadence table — the function that decides what this product costs.
 *
 * The important test here is the EXHAUSTIVE one: every member of
 * `TRACKING_STATUSES` must have an entry. A `default` branch would give a newly
 * added status some arbitrary cadence, and the symptom would be a bill or a
 * latency nobody can trace back to a missing line.
 */

import { describe, expect, it } from 'vitest';
import { TRACKING_STATUSES } from '@moovo/shared-types';
import { TRACKING_CADENCE, failureBackoffMs, nextPollAt } from '../tracking-cadence.js';
import { TRACKING_TERMINAL_STATUSES } from '../tracking-status.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
/** Fixed, so a range assertion is about the formula and not about luck. */
const MID = () => 0.5;

function due(overrides: Partial<Parameters<typeof nextPollAt>[0]> = {}) {
  return nextPollAt({
    status: 'in_transit',
    pollMode: 'poll',
    subscriberCount: 1,
    lastCheckpointAt: NOW,
    now: NOW,
    random: MID,
    ...overrides,
  });
}

const minutesUntil = (date: Date | null) =>
  date === null ? null : (date.getTime() - NOW.getTime()) / 60_000;

describe('TRACKING_CADENCE', () => {
  it('has an entry for every tracking status', () => {
    for (const status of TRACKING_STATUSES) {
      expect(Object.hasOwn(TRACKING_CADENCE, status)).toBe(true);
    }
    expect(Object.keys(TRACKING_CADENCE).sort()).toEqual([...TRACKING_STATUSES].sort());
  });

  it('gives every terminal status a null cadence, and every other status a real one', () => {
    for (const status of TRACKING_STATUSES) {
      const entry = TRACKING_CADENCE[status];
      const terminal = TRACKING_TERMINAL_STATUSES.includes(status);
      expect(entry === null).toBe(terminal);
    }
  });
});

describe('nextPollAt', () => {
  it('asks again in minutes when a parcel is out for delivery', () => {
    // The one state worth spending on: the difference between a useful push and
    // one that arrives after the doorbell.
    expect(minutesUntil(due({ status: 'out_for_delivery' }))).toBe(20);
  });

  it('backs off as a parcel goes quiet', () => {
    const fresh = minutesUntil(due({ status: 'in_transit', lastCheckpointAt: NOW }))!;
    const stale = minutesUntil(
      due({ status: 'in_transit', lastCheckpointAt: new Date('2026-02-25T12:00:00.000Z') }),
    )!;
    expect(stale).toBeGreaterThan(fresh);
  });

  it('stops forever once a parcel is delivered', () => {
    for (const status of TRACKING_TERMINAL_STATUSES) {
      expect(due({ status })).toBeNull();
    }
  });

  it('stops the moment nobody is watching — this is what an anonymous lookup costs', () => {
    // One carrier call, ever. The row stays as a shared cache; it just stops
    // buying answers nobody reads.
    expect(due({ subscriberCount: 0 })).toBeNull();
  });

  it('never schedules a carrier we cannot call', () => {
    // The database enforces the same thing; this is the polite half.
    expect(due({ pollMode: 'deeplink' })).toBeNull();
    expect(due({ pollMode: 'manual' })).toBeNull();
  });

  it('keeps polling a webhook carrier, slowly, rather than not at all', () => {
    // A push feed that stops silently is exactly what a backstop is for. `null`
    // here would mean the parcel freezes and nothing ever notices.
    const polled = minutesUntil(due({ pollMode: 'poll' }))!;
    const pushed = minutesUntil(due({ pollMode: 'webhook' }))!;
    expect(pushed).toBe(polled * 8);
    expect(pushed).not.toBeNull();
  });

  it('schedules a never-fetched parcel immediately', () => {
    expect(minutesUntil(due({ status: 'pending', lastCheckpointAt: null }))).toBe(0);
  });

  it('spreads due times so a batch added together does not stay together', () => {
    const low = minutesUntil(due({ status: 'out_for_delivery', random: () => 0 }))!;
    const high = minutesUntil(due({ status: 'out_for_delivery', random: () => 1 }))!;
    expect(low).toBe(17);
    expect(high).toBe(23);
    expect(high).toBeGreaterThan(low);
  });
});

describe('failureBackoffMs', () => {
  it('grows exponentially and stops at six hours', () => {
    expect(failureBackoffMs(1)).toBe(1_000);
    expect(failureBackoffMs(2)).toBe(2_000);
    expect(failureBackoffMs(5)).toBe(16_000);
    expect(failureBackoffMs(50)).toBe(6 * 60 * 60 * 1_000);
  });

  it('treats a zeroth failure as the first, rather than as no wait at all', () => {
    expect(failureBackoffMs(0)).toBe(1_000);
  });
});

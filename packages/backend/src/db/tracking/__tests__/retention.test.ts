/**
 * The two retention policies, and the moment they swap.
 *
 * `ExpirySweepTarget` has no predicate field, so both policies have to arrive
 * at the sweep as one already-computed deadline. That makes this function the
 * only place the distinction exists — and a bug in it deletes a customer's
 * parcel history with no error anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  TRACKED_PARCEL_UNWATCHED_RETENTION_SECONDS,
  TRACKED_PARCEL_WATCHED_RETENTION_SECONDS,
  trackedParcelExpiresAt,
} from '../retention';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const seconds = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 1000;

describe('trackedParcelExpiresAt', () => {
  it('gives an unwatched parcel the short window', () => {
    // The typo, the abandoned paste, the one-off anonymous lookup. This is the
    // number that actually bounds a table anyone can write to.
    const expiresAt = trackedParcelExpiresAt({ now: NOW, subscriberCount: 0, terminalAt: null });
    expect(seconds(NOW, expiresAt)).toBe(TRACKED_PARCEL_UNWATCHED_RETENTION_SECONDS);
  });

  it('measures a watched, still-moving parcel from now, so it keeps pushing its own deadline out', () => {
    const expiresAt = trackedParcelExpiresAt({ now: NOW, subscriberCount: 1, terminalAt: null });
    expect(seconds(NOW, expiresAt)).toBe(TRACKED_PARCEL_WATCHED_RETENTION_SECONDS);
  });

  it('measures a delivered parcel from the DELIVERY, not from the last write', () => {
    // Otherwise a delivered parcel that something keeps touching never ages
    // out, and the retention silently becomes "forever, if anyone looks".
    const terminalAt = new Date('2026-02-01T00:00:00.000Z');
    const expiresAt = trackedParcelExpiresAt({ now: NOW, subscriberCount: 1, terminalAt });
    expect(seconds(terminalAt, expiresAt)).toBe(TRACKED_PARCEL_WATCHED_RETENTION_SECONDS);
    expect(expiresAt.getTime()).toBeLessThan(
      NOW.getTime() + TRACKED_PARCEL_WATCHED_RETENTION_SECONDS * 1000,
    );
  });

  it('falls back to the short window the moment the last subscriber leaves', () => {
    // Unsubscribing is a write, so the deadline collapses on that same write
    // rather than waiting for a sweep to notice.
    const terminalAt = new Date('2026-02-01T00:00:00.000Z');
    const expiresAt = trackedParcelExpiresAt({ now: NOW, subscriberCount: 0, terminalAt });
    expect(seconds(NOW, expiresAt)).toBe(TRACKED_PARCEL_UNWATCHED_RETENTION_SECONDS);
  });
});

/**
 * Does anything actually START the tracking poller?
 *
 * The same failure shape `expiry-wiring.test.ts` guards against, arriving in a
 * new domain — and here it is worse, because the tracker looks HEALTHIER when
 * broken. A poller that is never started leaves every table filling normally:
 * carriers seed, parcels are created, subscriptions are written, `next_poll_at`
 * is set. Nothing errors. No checkpoint ever arrives, and the symptom reads as
 * every carrier being down at once — which is the one explanation nobody
 * doubts, because it is also what a genuine outage looks like.
 *
 * So this reads the ENTRYPOINT SOURCE, with comments stripped: `index.ts`
 * explains at length why each background loop is started, naming this one
 * repeatedly, so a scan over raw source would be satisfied by the prose alone
 * and deleting the call would leave the test green.
 *
 * It needs no database, so it runs everywhere the suite runs. The wiring is
 * exactly the thing that must not be conditional on the environment testing it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { TRACKING_STATUS_META } from '../tracking-events.service.js';
import { EVENTS } from '../../../lib/socket-events.js';
import { NOTIFICATION_TYPES } from '../../../db/schema/valueSets.js';
import { registerBuiltInTrackingAdapters } from '../register-tracking-adapters.js';
import { __resetTrackingRegistryForTests } from '../tracking-registry.js';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'index.ts');

function entrypointCode(): string {
  return readFileSync(ENTRYPOINT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

beforeEach(() => {
  __resetTrackingRegistryForTests();
  registerBuiltInTrackingAdapters();
});

describe('the tracking poller is wired into the server entrypoint', () => {
  it('reads an entrypoint that is actually there', () => {
    // Vacuity floor: a path resolving to nothing would make every assertion
    // below pass against an empty string.
    const code = entrypointCode();
    expect(code.length).toBeGreaterThan(2_000);
    expect(code).toContain('server.listen');
  });

  it('imports and CALLS startTrackingPollDispatcher', () => {
    const code = entrypointCode();
    expect(code).toMatch(
      /import\s*\{[^}]*startTrackingPollDispatcher[^}]*\}\s*from\s*'\.\/services\/tracking\/tracking-poll\.dispatcher\.js'/,
    );
    // The call, not merely the identifier: an import with no invocation is
    // precisely the bug this file exists for.
    expect(code).toMatch(/startTrackingPollDispatcher\s*\(\s*\)/);
  });

  it('stops the dispatcher on shutdown', () => {
    // An abandoned lease is reclaimed once it lapses, so this is not a
    // correctness matter — but skipping it costs a lease-length delay on every
    // parcel in flight, on every deploy.
    const code = entrypointCode();
    expect(code).toMatch(/stopTrackingPollDispatcher\s*\(\s*\)/);
  });

  it('registers and seeds the carriers at boot', () => {
    const code = entrypointCode();
    expect(code).toMatch(/registerBuiltInTrackingAdapters\s*\(\s*\)/);
    expect(code).toMatch(/seedTrackingCarriers\s*\(\s*\)/);
  });
});

describe('what the tracker notifies about', () => {
  it('interrupts people for EXACTLY these statuses', () => {
    // Compared as an exact set, following `DELIVERY_FACT_KEYS`. A list of
    // "must not notify on `in_transit`" assertions only fails when a named
    // status disappears, and is completely silent about one somebody ADDS —
    // which is how a notification-spam regression actually arrives.
    expect(Object.keys(TRACKING_STATUS_META).sort()).toEqual(
      [
        'available_for_pickup',
        'delivered',
        'exception',
        'failed_attempt',
        'out_for_delivery',
        'returned',
      ].sort(),
    );
  });

  it('stays silent while a parcel is merely moving', () => {
    // The three that would generate a push per depot scan. Redundant with the
    // exact-set assertion above by design: this one says WHY those three.
    expect(TRACKING_STATUS_META).not.toHaveProperty('pending');
    expect(TRACKING_STATUS_META).not.toHaveProperty('info_received');
    expect(TRACKING_STATUS_META).not.toHaveProperty('in_transit');
  });

  it('names only notification types the CHECK constraint accepts', () => {
    // The tuple generates the constraint, so a type absent from it is a 23514
    // at runtime — and only where a real database exists, which is to say not
    // in any mocked test.
    for (const meta of Object.values(TRACKING_STATUS_META)) {
      expect(NOTIFICATION_TYPES).toContain(meta!.notification);
    }
  });

  it('emits through the frozen socket registry rather than raw strings', () => {
    expect(EVENTS.TRACKING_STATUS).toBe('tracking:status');
    expect(EVENTS.TRACKING_UPDATED).toBe('tracking:updated');
  });
});

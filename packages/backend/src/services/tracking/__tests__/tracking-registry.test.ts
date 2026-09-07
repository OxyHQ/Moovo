/**
 * The registry's shape invariants.
 *
 * These are the ones that hold the "a deep-link carrier is expressed by an
 * ABSENT `fetch`" design together. An adapter that claims `fetch: true` with no
 * `fetch` method, or one with no `deepLink`, would both fail at the worst
 * moment: the first inside the poll loop, the second in the UI of a parcel
 * whose carrier just stopped answering.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltInTrackingAdapters } from '../register-tracking-adapters.js';
import {
  __resetTrackingRegistryForTests,
  listFetchingTrackingAdapters,
  listTrackingAdapters,
} from '../tracking-registry.js';
import { BUILT_IN_TRACKING_CARRIERS } from '../adapters/built-in-carriers.js';
import { deepLinkTemplate } from '../adapters/deeplink-carrier.js';

beforeEach(() => {
  __resetTrackingRegistryForTests();
  registerBuiltInTrackingAdapters();
});

describe('the built-in tracking adapters', () => {
  it('registers every carrier in the catalogue, once', () => {
    const keys = listTrackingAdapters().map((adapter) => adapter.key);
    expect(keys).toHaveLength(BUILT_IN_TRACKING_CARRIERS.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every adapter a deep link, including ones that will later poll', () => {
    // It is the "view on the carrier's site" button the app always shows, and
    // the fallback when polling has given up on a parcel.
    for (const adapter of listTrackingAdapters()) {
      const url = adapter.deepLink({ trackingNumber: '1Z999AA10123456784' });
      expect(url).toMatch(/^https:\/\//);
      expect(url.length).toBeGreaterThan('https://'.length);
    }
  });

  it('has fetch exactly when it is not deep-link-only', () => {
    for (const adapter of listTrackingAdapters()) {
      const { fetch, deepLinkOnly } = adapter.capabilities;
      expect(fetch).toBe(!deepLinkOnly);
      expect(typeof adapter.fetch === 'function').toBe(fetch);
    }
  });

  it('has a webhook parser exactly when it claims webhook support', () => {
    for (const adapter of listTrackingAdapters()) {
      const claimed = adapter.capabilities.webhook;
      expect(typeof adapter.parseWebhook === 'function').toBe(claimed);
      expect(typeof adapter.verifyWebhook === 'function').toBe(claimed);
    }
  });

  it('ships with NO fetching adapter yet, which is why the poller stays off', () => {
    // Stated as a test rather than left implicit: every carrier is deep-link
    // only until its client has been written against the real API and pinned
    // with recorded fixtures. When the first one lands this assertion flips,
    // and flipping it should be a deliberate line in that PR.
    expect(listFetchingTrackingAdapters()).toHaveLength(0);
  });

  it('produces a seedable template with the placeholder intact', () => {
    // The template goes into `tracking_carriers.deep_link_template`, where an
    // operator can fix it without a deploy. A URL-encoded placeholder would
    // store `%7Bnumber%7D` and every link would 404 with the literal text in it.
    for (const carrier of BUILT_IN_TRACKING_CARRIERS) {
      const template = deepLinkTemplate(carrier.adapter);
      expect(template).not.toContain('%7B');
      if (carrier.adapter.key !== 'amazon') {
        expect(template).toContain('{number}');
      }
    }
  });
});

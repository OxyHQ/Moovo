/**
 * Carrier webhook ingestion: the mount order, and the trap next door.
 *
 * Two properties, and neither can be read off the router in isolation.
 *
 * **The mount must stay ahead of `express.json()`.** A signature covers the
 * bytes that ARRIVED; once a parser has run they are gone, and verifying over a
 * re-serialisation verifies nothing. An ordering test for the CrowdSource
 * router says nothing about this one, so this router needs its own.
 *
 * **`express.raw` must stay scoped to `/webhooks/tracking`.** This is the
 * sharper of the two, because getting it wrong breaks a DIFFERENT file's
 * guarantee: `@oxy.so/crowdsource-express` prefers a Buffer already stashed on
 * the request over reading the stream, so a raw parser mounted at `/webhooks`
 * would turn that router's loud refusal of a late mount into silent success —
 * with nothing in its own file changed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configuredWebhookCarriers, createTrackingWebhookRoutes } from '../tracking-webhook.js';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts');

function entrypoint(): string {
  return readFileSync(ENTRYPOINT, 'utf8');
}

/**
 * Source with comments removed, for the ORDERING assertions only.
 *
 * The entrypoint explains at length why each webhook router is mounted where it
 * is, naming `express.json()` in prose well above the code that calls it — so a
 * positional comparison over raw source compares against a sentence. The
 * literal-string assertions below deliberately keep the comments, because a
 * blunt check over the whole file is what makes them reliable.
 */
function entrypointCode(): string {
  return entrypoint()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('where the tracking webhook is mounted', () => {
  it('reads an entrypoint that is actually there', () => {
    // Vacuity floor: a path resolving to nothing would make every assertion
    // below pass against an empty string.
    expect(entrypoint().length).toBeGreaterThan(2_000);
  });

  it('mounts BEFORE the JSON parser', () => {
    const code = entrypointCode();
    const mount = code.indexOf('createTrackingWebhookRoutes()');
    const json = code.indexOf('express.json(');
    expect(mount).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    // Strictly before. A parser ahead of this router destroys the bytes the
    // signature is over, and the failure is a webhook that verifies nothing
    // while appearing to work.
    expect(mount).toBeLessThan(json);
  });

  it('does NOT mount a raw parser at /webhooks', () => {
    // The trap that breaks the neighbouring router rather than this one.
    const code = entrypoint();
    expect(code).not.toMatch(/app\.use\(\s*'\/webhooks'\s*,\s*(express\.)?raw\s*\(/);
  });

  it('keeps every byte of raw-body handling out of the entrypoint', () => {
    const code = entrypoint();
    expect(code).not.toMatch(/verify\s*:/);
    expect(code).not.toMatch(/express\.raw\s*\(/);
  });
});

describe('when no carrier has a secret', () => {
  it('is not mounted at all, rather than mounted and permissive', () => {
    // A route that answers without verifying is one somebody will later reason
    // about as if it verified. `null` makes that impossible instead of
    // improbable.
    const before = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('TRACKING_WEBHOOK_SECRET_')) delete process.env[name];
    }
    try {
      expect(configuredWebhookCarriers()).toEqual([]);
      expect(createTrackingWebhookRoutes()).toBeNull();
    } finally {
      Object.assign(process.env, before);
    }
  });

  it('reads a carrier key back out of the environment variable name', () => {
    const before = process.env.TRACKING_WEBHOOK_SECRET_DHL_EXPRESS;
    process.env.TRACKING_WEBHOOK_SECRET_DHL_EXPRESS = 'a-secret';
    try {
      // `dhl-express`, not `DHL_EXPRESS`: the name has to round-trip to the
      // adapter key or the router mounts for a carrier nothing can serve.
      expect(configuredWebhookCarriers()).toContain('dhl-express');
    } finally {
      if (before === undefined) delete process.env.TRACKING_WEBHOOK_SECRET_DHL_EXPRESS;
      else process.env.TRACKING_WEBHOOK_SECRET_DHL_EXPRESS = before;
    }
  });

  it('ignores a _PREVIOUS secret on its own', () => {
    // A rotation leftover must not keep a route alive after the live secret has
    // been removed.
    const before = process.env.TRACKING_WEBHOOK_SECRET_UPS_PREVIOUS;
    process.env.TRACKING_WEBHOOK_SECRET_UPS_PREVIOUS = 'old';
    try {
      expect(configuredWebhookCarriers()).not.toContain('ups');
    } finally {
      if (before === undefined) delete process.env.TRACKING_WEBHOOK_SECRET_UPS_PREVIOUS;
      else process.env.TRACKING_WEBHOOK_SECRET_UPS_PREVIOUS = before;
    }
  });
});

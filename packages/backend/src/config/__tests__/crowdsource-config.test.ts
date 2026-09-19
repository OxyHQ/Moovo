/**
 * What `CROWDSOURCE_ENABLED=true` now needs, and what it must stop needing.
 *
 * The delivery loop used to require a `CROWDSOURCE_SERVICE_KEY` as well as the
 * webhook secret, and that requirement outlived the key: Moovo authenticates to
 * CrowdSource with the Oxy service token it mints from its ECS task role (oxy
 * ADR 0026), so the variable reaches nothing. A check on it would have refused
 * to arm the loop on exactly the deployment that can deliver — reports piling up
 * in a durable outbox behind a flag that reads as OFF, with no error anywhere
 * because refusing to enable is not an error.
 *
 * Both directions are pinned. The webhook secret is still required, because a
 * report delivered with no way to verify the decision coming back is worse than
 * one held locally; and setting a service key is asserted to change NOTHING, so
 * a reader who finds one in an old `.env` learns from the suite that it is inert
 * rather than from a deployment that behaves as if it were not.
 *
 * `config` is read once at module load, so each case re-imports it under
 * `vi.resetModules()` rather than mutating a frozen object.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadCrowdSourceConfig() {
  vi.resetModules();
  const { config } = await import('../index.js');
  return config.crowdSource;
}

describe('CROWDSOURCE_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('arms the delivery loop with a webhook secret and NO service key', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', undefined);
    await expect(loadCrowdSourceConfig()).resolves.toMatchObject({ enabled: true });
  });

  it('is inert to CROWDSOURCE_SERVICE_KEY, which nothing reads any more', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_1:cred_1:secret');
    const withKey = await loadCrowdSourceConfig();
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', undefined);
    const withoutKey = await loadCrowdSourceConfig();
    expect(withKey).toEqual(withoutKey);
    expect(withKey).not.toHaveProperty('serviceKey');
  });

  it('refuses to enable without the webhook secret', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', undefined);
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_1:cred_1:secret');
    await expect(loadCrowdSourceConfig()).resolves.toMatchObject({ enabled: false });
  });

  /** A blank secret is a placeholder, not a configured one. */
  it('reads a blank webhook secret as unset', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', '   ');
    await expect(loadCrowdSourceConfig()).resolves.toMatchObject({ enabled: false });
  });

  it('stays off when the flag is unset, however much else is configured', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', undefined);
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'whsec_test');
    await expect(loadCrowdSourceConfig()).resolves.toMatchObject({ enabled: false });
  });
});

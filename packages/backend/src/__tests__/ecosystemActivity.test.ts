import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubEnv, unstubAllEnvs } from './fixtures/runner-compat';

/*
 * Runs under vitest AND `bun test` (see `test:bun`): the mocks are plain
 * constants and the module under test is imported dynamically AFTER the mock is
 * registered, because bun:test has no `vi.hoisted` and does not hoist `vi.mock`.
 */
const publisher = {
  observeHttp: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: vi.fn(),
  observeSocket: vi.fn(),
  stop: vi.fn(async () => {}),
};
const create = vi.fn((_options: unknown) => publisher);
/**
 * `canAttestWorkloadIdentity` is stubbed rather than driven through its real
 * environment variable, because the real one is set by ECS and by nothing else:
 * a test that arranged `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` would be
 * asserting this suite's idea of how the SDK detects a task role rather than
 * what Moovo does with the answer.
 */
const canAttest = vi.fn(() => false);
vi.mock('@oxy.so/core/server', () => ({
  createEcosystemTraffic: create,
  canAttestWorkloadIdentity: canAttest,
}));

type Module = typeof import('../ecosystemActivity');
let ecosystemActivityMiddleware: Module['ecosystemActivityMiddleware'];
let observeEcosystemSocket: Module['observeEcosystemSocket'];
let startEcosystemActivity: Module['startEcosystemActivity'];
let stopEcosystemActivity: Module['stopEcosystemActivity'];

beforeAll(async () => {
  ({
    ecosystemActivityMiddleware,
    observeEcosystemSocket,
    startEcosystemActivity,
    stopEcosystemActivity,
  } = await import('../ecosystemActivity'));
});

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    stubEnv('OXY_SERVICE_API_KEY', 'test-key');
    stubEnv('OXY_SERVICE_API_SECRET', 'test-secret');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
    canAttest.mockReturnValue(true);
  });
  afterEach(async () => {
    await stopEcosystemActivity();
    unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not start without an attestable workload identity', () => {
    canAttest.mockReturnValue(false);
    stubEnv('OXY_SERVICE_API_KEY', undefined);
    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('does not promote customer keys to own identity', () => {
    canAttest.mockReturnValue(false);

    startEcosystemActivity(() => true);
    expect(create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  /**
   * The case this gate exists for, and the one it used to get wrong.
   *
   * A deployed Moovo carries no credential pair at all: it attests its ECS task
   * role and the SDK mints the same service token (oxy ADR 0026). A check on the
   * two variables reads that task as unconfigured and publishes NOTHING, which
   * on the dashboard is indistinguishable from a service with no traffic — the
   * exact reading `docs/ecosystem-activity.md` says must never be made.
   */
  it('starts on an attesting deployment that carries no credential pair', () => {
    canAttest.mockReturnValue(true);
    stubEnv('OXY_SERVICE_API_KEY', undefined);
    stubEnv('OXY_SERVICE_API_SECRET', undefined);
    startEcosystemActivity(() => true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails boot when the shared collector rejects its configuration', () => {
    create.mockImplementationOnce(() => {
      throw new Error('Invalid infrastructure region');
    });
    expect(() => startEcosystemActivity(() => true)).toThrow('Invalid infrastructure region');
    expect(publisher.installFetch).not.toHaveBeenCalled();
  });

  it('installs once and supplies live readiness without retaining request bodies', async () => {
    let ready = false;
    startEcosystemActivity(() => ready);
    startEcosystemActivity(() => ready);
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
    const socket = {} as never;
    observeEcosystemSocket(socket);
    expect(publisher.observeSocket).toHaveBeenCalledWith(socket);
    const options = create.mock.calls[0]?.[0] as unknown as { service: string; ready(): boolean };
    expect(options.service).toBe('moovo');
    expect(options.ready()).toBe(false);
    ready = true;
    expect(options.ready()).toBe(true);
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    expect(publisher.observeHttp).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});

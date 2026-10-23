import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createEcosystemTraffic } from '@oxy.so/core/server';
import { workloadCredentials } from '../workload';
import {
  ecosystemActivityMiddleware,
  observeEcosystemSocket,
  startEcosystemActivity,
  stopEcosystemActivity,
} from '../ecosystemActivity';

const publisher = {
  observeHttp: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  installFetch: vi.fn(),
  observeSocket: vi.fn(),
  stop: vi.fn(async () => {}),
};
const create = vi.fn(
  (_options: Parameters<typeof createEcosystemTraffic>[0]) =>
    publisher as unknown as ReturnType<typeof createEcosystemTraffic>,
);

describe('ecosystem activity lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(stopEcosystemActivity);

  it('missing infrastructure region leaves public requests available', () => {
    startEcosystemActivity(() => true, create, '');
    expect(create).not.toHaveBeenCalled();
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    observeEcosystemSocket({} as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(publisher.observeSocket).not.toHaveBeenCalled();
  });

  it('uses temporary role credentials without ECS markers or customer keys', () => {
    const ready = () => true;
    startEcosystemActivity(ready, create, 'us-west-2');
    expect(create).toHaveBeenCalledWith({
      service: 'moovo',
      ready,
      region: 'us-west-2',
      workloadCredentials,
    });
    expect(publisher.installFetch).toHaveBeenCalledTimes(1);
  });

  it('fails boot when the shared collector rejects its configuration', () => {
    create.mockImplementationOnce(() => {
      throw new Error('Invalid infrastructure region');
    });
    expect(() => startEcosystemActivity(() => true, create, 'invalid-region')).toThrow(
      'Invalid infrastructure region',
    );
    expect(publisher.installFetch).not.toHaveBeenCalled();
  });

  it('installs once, observes HTTP/socket and stops exactly once', async () => {
    let ready = false;
    startEcosystemActivity(() => ready, create, 'us-west-2');
    startEcosystemActivity(() => ready, create, 'us-west-2');
    expect(create).toHaveBeenCalledTimes(1);
    const socket = {} as never;
    observeEcosystemSocket(socket);
    expect(publisher.observeSocket).toHaveBeenCalledWith(socket);
    const options = create.mock.calls[0]?.[0] as unknown as { ready(): boolean };
    expect(options.ready()).toBe(false);
    ready = true;
    expect(options.ready()).toBe(true);
    const next = vi.fn();
    ecosystemActivityMiddleware({} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    await stopEcosystemActivity();
    await stopEcosystemActivity();
    expect(publisher.stop).toHaveBeenCalledTimes(1);
  });
});

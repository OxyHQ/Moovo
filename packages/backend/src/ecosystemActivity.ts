import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Own identity comes from the registered workload, never a customer key pair. */
export function canAuthenticateAsOxyService(): boolean {
  return canAttestWorkloadIdentity();
}

/** Start only at process bootstrap; constructing a test app starts no publisher. */
export function startEcosystemActivity(ready: () => boolean): void {
  /**
   * Skipped rather than thrown, which is the shape this already had and worth
   * keeping: a laptop and a CI box have no identity to offer, and refusing to
   * boot the API over a telemetry publisher would trade a missing dashboard line
   * for a service that does not run. The SDK throws in exactly this case, so the
   * check has to stay in front of the call rather than be delegated to it.
   */
  if (!canAuthenticateAsOxyService()) {
    console.warn('Ecosystem activity is disabled for moovo: no attestable workload identity');
    return;
  }
  if (activity) return;
  activity = createEcosystemTraffic({
    service: 'moovo',
    ready,
  });
  activity.installFetch();
}

export const ecosystemActivityMiddleware: RequestHandler = (request, response, next) => {
  if (activity) activity.observeHttp(request, response, next);
  else next();
};

export function observeEcosystemSocket(
  socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0],
): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}

import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/**
 * Whether this process can act as the Oxy application `moovo` AT ALL.
 *
 * The question the key check below was always asking, and the reason it had to
 * stop asking it by name. Under oxy ADR 0026 a first-party service proves what
 * it IS: on ECS the task role attests and there is no secret anywhere, and
 * `createEcosystemTraffic` mints from whichever of the two it finds. A deployed
 * Moovo therefore carries neither variable.
 *
 * Read this rather than the pair, because the pair's absence is no longer
 * evidence of anything. On the deploy that drops the two variables a key check
 * would take the `return` below on a task whose identity is its ROLE — and what
 * that looks like from outside is Moovo reporting zero traffic and zero
 * infrastructure to the dashboard, with one warning line in the log and nothing
 * anywhere saying the publisher was never started. `docs/ecosystem-activity.md`
 * already names that reading as the thing not to do: disabled collection must
 * not be interpreted as zero traffic.
 *
 * A checkout that can neither attest nor present a pair is still the honest
 * "Moovo cannot act as itself here", and the two names are still the thing to
 * set THERE.
 */
function canAuthenticateAsOxyService(): boolean {
  return (
    canAttestWorkloadIdentity() ||
    Boolean(process.env.OXY_SERVICE_API_KEY?.trim() && process.env.OXY_SERVICE_API_SECRET?.trim())
  );
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
    console.warn(
      'Ecosystem activity is disabled for moovo: no attestable workload identity and no ' +
        'OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET pair',
    );
    return undefined;
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

export function observeEcosystemSocket(socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0]): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}

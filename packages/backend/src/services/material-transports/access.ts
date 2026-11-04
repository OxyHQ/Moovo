import {
  OxyAccessError,
  accessErrorStatus,
  getOxyActor,
  getOxyUserId,
  type OxyCallerRequest,
} from '@oxy.so/core/server';
import type { Request } from 'express';
import { createMercariaClient, MercariaApiError } from '@mercaria.co/sdk';
import { ERROR_STATUS, type TransportErrorCode } from '@oxy.so/moovo-contracts';
import { oxyClient } from '../../middleware/auth';
export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
  }
  get status() {
    return ERROR_STATUS[this.code];
  }
}
export interface TransportCaller {
  accountId: string;
  actorAccountId: string;
  delegated: boolean;
  /** The verified request: Oxy is asked with its own bearer, never a copy of it. */
  request: OxyCallerRequest;
}
export function transportCaller(req: Request): TransportCaller {
  const accountId = getOxyUserId(req);
  const actor = getOxyActor(req);
  if (!accountId || !actor?.actorAccountId || !req.accessToken)
    throw new TransportError('unauthorized', 'Sign in to manage transport');
  return {
    accountId,
    actorAccountId: actor.actorAccountId,
    delegated: actor.delegated,
    request: req,
  };
}
/** Oxy's access outcome in this API's vocabulary: an outage is `service_unavailable`, never a refusal. */
export function transportAccessError(err: OxyAccessError): TransportError {
  switch (accessErrorStatus(err)) {
    case 401:
      return new TransportError('unauthorized', 'Your Oxy session expired');
    case 503:
      return new TransportError('service_unavailable', 'Account access cannot be verified');
    default:
      return new TransportError('forbidden', 'Account access denied');
  }
}
/**
 * May the caller act for `accountId`? Their own personal account needs no
 * question; any other account is answered by Oxy with the caller's own
 * session, on permissions (grants and revokes applied), never a role name:
 * preparing a transport needs `account:act_as` (owner, admin, editor), approving
 * expenditure `account:update` (owner, admin). Asked fresh: each call precedes
 * a decision.
 */
export async function authorizeAccount(
  caller: TransportCaller,
  accountId: string,
  payment = false,
  requireOrganization = false,
) {
  if (
    !requireOrganization &&
    !caller.delegated &&
    caller.accountId === accountId &&
    caller.actorAccountId === accountId
  )
    return;
  const access = await oxyClient
    .accountAccessFor(caller.request, accountId, { fresh: true })
    .catch((err: unknown) => {
      throw err instanceof OxyAccessError ? transportAccessError(err) : err;
    });
  if (requireOrganization && access.kind !== 'organization')
    throw new TransportError('forbidden', 'A sponsoring payer must be an organization');
  if (!access.has(payment ? 'account:update' : 'account:act_as'))
    throw new TransportError('forbidden', 'This account does not authorize this action');
  // A third-party payer must be an organization, or the operator's own personal account.
  if (payment && access.relationship !== 'self' && access.kind !== 'organization')
    throw new TransportError(
      'forbidden',
      'Only your own account or an authorized organization may pay',
    );
}
/** A linked client on the caller's own session, read-only, fixed receiving product; disposed with the request. */
export async function readReservation(
  caller: TransportCaller,
  reservationId: string,
  accountId: string,
) {
  const baseURL = process.env.MERCARIA_API_URL || 'https://api.mercaria.co';
  return oxyClient.withUser(caller.request, async (oxy) => {
    const linked = oxy.createLinkedClient({ baseURL });
    const client = createMercariaClient({
      apiBaseUrl: baseURL,
      fetch: (url, init) =>
        linked.client.requestAuthenticatedResponse({
          url,
          method: init.method,
          body: init.body,
          signal: init.signal,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    try {
      return await client.materials.getReservation(reservationId, accountId);
    } catch (err) {
      if (err instanceof MercariaApiError && [401, 403, 404].includes(err.status ?? 0))
        throw new TransportError('not_found', 'Reservation unavailable to this account');
      throw new TransportError('service_unavailable', 'Mercaria could not verify the reservation');
    } finally {
      linked.dispose();
    }
  });
}

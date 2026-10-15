import { OxyServices, OxyApiError } from '@oxy.so/core';
import { getOxyActor, getOxyUserId } from '@oxy.so/core/server';
import type { Request } from 'express';
import { createMercariaClient, MercariaApiError } from '@mercaria.co/sdk';
import { ERROR_STATUS, type TransportErrorCode } from '@oxy.so/moovo-contracts';
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
  accessToken: string;
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
    accessToken: req.accessToken,
  };
}
export function callerOxy(caller: TransportCaller) {
  const oxy = new OxyServices({
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    enableCache: false,
  });
  oxy.session.setAccessToken(caller.accessToken);
  return oxy;
}
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
  const oxy = callerOxy(caller);
  try {
    const node = await oxy.accounts.get(accountId);
    if (requireOrganization && node.kind !== 'organization')
      throw new TransportError('forbidden', 'A sponsoring payer must be an organization');
    const role =
      node.relationship === 'self' || node.relationship === 'owner'
        ? 'owner'
        : node.callerMembership?.status === 'active'
          ? node.callerMembership.role
          : null;
    if (role !== 'owner' && role !== 'admin' && (payment || role !== 'editor'))
      throw new TransportError('forbidden', 'This account does not authorize this action');
    // A third-party payer must be an organization, or the operator's own personal account.
    if (payment && node.relationship !== 'self' && node.kind !== 'organization')
      throw new TransportError(
        'forbidden',
        'Only your own account or an authorized organization may pay',
      );
  } catch (err) {
    if (err instanceof TransportError) throw err;
    if (err instanceof OxyApiError && (err.status === 403 || err.status === 404))
      throw new TransportError('forbidden', 'Account access denied');
    if (err instanceof OxyApiError && err.status === 401)
      throw new TransportError('unauthorized', 'Your Oxy session expired');
    throw new TransportError('service_unavailable', 'Account access cannot be verified');
  } finally {
    oxy.dispose();
  }
}
/** Request-local linked Oxy client, read-only, fixed receiving product. No caller token is retained. */
export async function readReservation(
  caller: TransportCaller,
  reservationId: string,
  accountId: string,
) {
  const oxy = callerOxy(caller);
  const baseURL = process.env.MERCARIA_API_URL || 'https://api.mercaria.co';
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
    oxy.dispose();
  }
}

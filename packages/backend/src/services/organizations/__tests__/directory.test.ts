import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { OxyAccessError } from '@oxy.so/core/server';
import type { CourierCompanyRecord } from '../../../db/fleet/courierCompanyRepository.js';
import { fromOxyAccessError, type MoovoError } from '../../../lib/errors/error-codes.js';
let server: Server;
let directory: typeof import('../directory.js');
let status = 200;
let role = 'owner';
let memberStatus = 'active';
const token = (id: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: 4102444800 })).toString('base64url')}.unsigned`;
/** A request `middleware.auth()` verified: the person, their session and its bearer. */
const caller = (id: string) => ({ userId: id, sessionId: `session-${id}`, accessToken: token(id) });
/** The HTTP status `respondWithError` answers a settled registration check with. */
const statusOf = (check: Promise<unknown>) =>
  check.then(
    () => 200,
    (error: unknown) =>
      (error instanceof OxyAccessError ? fromOxyAccessError(error) : (error as MoovoError))
        .httpStatus,
  );
/** Effective account permissions Oxy answers per role (the baseline, no grants). */
const PERMISSIONS: Record<string, string[]> = {
  owner: ['account:read', 'account:update', 'account:act_as', 'members:update'],
  admin: ['account:read', 'account:update', 'account:act_as', 'members:update'],
  viewer: ['account:read', 'members:read'],
};
const seen: { path: string; authorization?: string; ids?: string[] }[] = [];
function organization(id: string) {
  return {
    accountId: id,
    name: `Canonical ${id}`,
    username: null,
    organizationType: 'business',
    avatar: null,
    legalName: null,
    websiteUrl: null,
    countryCode: null,
    aliases: [],
    verifiedDomains: [],
    claimStatus: 'claimed',
    status: id === 'hidden' ? 'suppressed' : 'active',
    mergedIntoAccountId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    const path = req.url || '';
    seen.push({ path, authorization: req.headers.authorization, ids: body.ids });
    res.setHeader('content-type', 'application/json');
    res.statusCode = status;
    if (status !== 200) {
      res.end(JSON.stringify({ message: 'unavailable' }));
      return;
    }
    if (path.startsWith('/accounts/')) {
      // Oxy answers a person with no active membership 403, with no access in the body.
      if (memberStatus !== 'active') {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 'forbidden', message: 'No access' } }));
        return;
      }
      res.end(
        JSON.stringify({
          account: {
            accountId: path.split('/').pop(),
            kind: 'organization',
            relationship: role === 'owner' ? 'owner' : 'member',
            callerMembership: { status: memberStatus, role },
            callerAccess: {
              role,
              permissions: PERMISSIONS[role],
              status: 'active',
              source: 'direct',
            },
          },
        }),
      );
    } else if (path === '/organizations/batch')
      res.end(
        JSON.stringify({
          items: body.ids
            .filter((id: string) => id !== 'missing')
            .map((id: string) => ({
              requestedAccountId: id,
              organization: organization(id === 'redirect' ? 'winner' : id),
            })),
          missingIds: body.ids.filter((id: string) => id === 'missing'),
        }),
      );
    else res.end(JSON.stringify(organization(path.split('/').pop() || '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  process.env.OXY_API_URL = `http://127.0.0.1:${address.port}`;
  directory = await import('../directory.js');
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  delete process.env.OXY_API_URL;
});
beforeEach(() => {
  seen.length = 0;
  status = 200;
  role = 'owner';
  memberStatus = 'active';
});
it("asks Oxy with each caller's own verified bearer; the public organization read carries none", async () => {
  await Promise.all([
    directory.requireOrganizationAdministrator(caller('one'), 'one'),
    directory.requireOrganizationAdministrator(caller('two'), 'two'),
  ]);
  expect(seen.filter((row) => row.path.startsWith('/accounts/'))).toEqual(
    expect.arrayContaining([
      { path: '/accounts/one', authorization: `Bearer ${token('one')}`, ids: undefined },
      { path: '/accounts/two', authorization: `Bearer ${token('two')}`, ids: undefined },
    ]),
  );
  expect(
    seen.filter((row) => row.path.startsWith('/organizations/')).every((row) => !row.authorization),
  ).toBe(true);
});
it('gates on account:update, so a viewer or a removed member is refused 403', async () => {
  role = 'viewer';
  expect(await statusOf(directory.requireOrganizationAdministrator(caller('owner'), 'one'))).toBe(
    403,
  );
  role = 'admin';
  await expect(
    directory.requireOrganizationAdministrator(caller('owner'), 'one'),
  ).resolves.toMatchObject({ accountId: 'one' });
  memberStatus = 'removed';
  expect(await statusOf(directory.requireOrganizationAdministrator(caller('owner'), 'one'))).toBe(
    403,
  );
});
// The SDK retries a 5xx with backoff before giving up, hence the longer timeout.
it('answers an Oxy outage 503, never caches it, and asks again on the next request', async () => {
  status = 503;
  expect(await statusOf(directory.requireOrganizationAdministrator(caller('owner'), 'one'))).toBe(
    503,
  );
  status = 200;
  seen.length = 0;
  await expect(
    directory.requireOrganizationAdministrator(caller('owner'), 'one'),
  ).resolves.toMatchObject({ accountId: 'one' });
  expect(seen.some((row) => row.path === '/accounts/one')).toBe(true);
}, 30_000);
it('answers 401 for a request with no person (anonymous, or a service token)', async () => {
  for (const request of [{}, { ...caller('owner'), serviceApp: { id: 'app' } }]) {
    expect(await statusOf(directory.requireOrganizationAdministrator(request, 'one'))).toBe(401);
  }
});
it('deduplicates bounded company hydration and respects canonical redirects, missing/suppressed records', async () => {
  const ids = [
    ...Array.from({ length: 201 }, (_, i) => String(i)),
    '0',
    'redirect',
    'hidden',
    'missing',
  ];
  const rows = ids.map((id, i) => ({ id: `fleet-${i}`, oxyAccountId: id }) as CourierCompanyRecord);
  const result = await directory.hydrateCompanies(rows);
  expect(seen.map((row) => row.ids?.length)).toEqual([100, 100, 4]);
  expect(result).toHaveLength(203);
  expect(result.find((row) => row.id === 'fleet-202')).toMatchObject({
    oxyAccountId: 'winner',
    name: 'Canonical winner',
  });
});

it('rejects local identity edits and requires canonical registration input', async () => {
  const { createCompanySchema, updateCompanySchema } = await import(
    '../../../middleware/schemas.js'
  );
  expect(createCompanySchema.safeParse({ name: 'Local company' }).success).toBe(false);
  expect(createCompanySchema.safeParse({ oxyAccountId: 'organization' }).success).toBe(true);
  expect(
    updateCompanySchema.safeParse({ name: 'Renamed', logoFileId: 'local-avatar' }).success,
  ).toBe(false);
});

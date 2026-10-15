import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { CourierCompanyRecord } from '../../../db/fleet/courierCompanyRepository.js';
let server: Server;
let directory: typeof import('../directory.js');
let status = 200;
let role = 'owner';
let memberStatus = 'active';
const token = (id: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: 4102444800 })).toString('base64url')}.unsigned`;
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
    if (path.startsWith('/accounts/'))
      res.end(
        JSON.stringify({
          account: {
            accountId: path.split('/').pop(),
            kind: 'organization',
            relationship: 'owner',
            callerMembership: { status: memberStatus, role },
          },
        }),
      );
    else if (path === '/organizations/batch')
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
it('uses each original verified bearer without shared client mutation and public reads omit it', async () => {
  await Promise.all([
    directory.requireOrganizationAdministrator('one', token('one')),
    directory.requireOrganizationAdministrator('two', token('two')),
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
it('refuses revoked/viewer memberships and fails closed on directory outage', async () => {
  role = 'viewer';
  await expect(
    directory.requireOrganizationAdministrator('one', token('owner')),
  ).rejects.toMatchObject({ httpStatus: 403 });
  role = 'owner';
  memberStatus = 'removed';
  await expect(
    directory.requireOrganizationAdministrator('one', token('owner')),
  ).rejects.toMatchObject({ httpStatus: 403 });
  memberStatus = 'active';
  status = 503;
  await expect(
    directory.requireOrganizationAdministrator('one', token('owner')),
  ).rejects.toMatchObject({ httpStatus: 503 });
  await expect(directory.requireOrganizationAdministrator('one', undefined)).rejects.toMatchObject({
    httpStatus: 401,
  });
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

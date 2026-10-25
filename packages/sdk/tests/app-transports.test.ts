import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';

const endpoint = vi.hoisted(() => ({ origin: '' }));
vi.mock('../../frontend/lib/config', () => ({
  default: {
    get apiUrl() {
      return endpoint.origin;
    },
  },
}));
vi.mock('../../courier-app/lib/config', () => ({
  default: {
    get apiUrl() {
      return endpoint.origin;
    },
  },
}));
vi.mock('../../fleet-dashboard/lib/config', () => ({
  default: {
    get apiUrl() {
      return endpoint.origin;
    },
  },
}));
vi.mock('../../tracker-app/lib/config', () => ({
  default: {
    get apiUrl() {
      return endpoint.origin;
    },
  },
}));

let server: Server;
let requests = 0;
let rejectNext = false;
beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    if (rejectNext) {
      rejectNext = false;
      res.writeHead(401).end('{}');
      return;
    }
    if (req.url === '/forbidden') {
      res.writeHead(403).end(JSON.stringify({ message: 'resource denied' }));
      return;
    }
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        path: req.url,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const token = (userId: string, generation = 0) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: `session-${userId}`, exp: Math.floor(Date.now() / 1000) + 600 + generation })).toString('base64url')}.fixture`;
for (const [name, load] of [
  ['customer', () => import('../../frontend/lib/api/client')],
  ['courier', () => import('../../courier-app/lib/api/client')],
  ['fleet', () => import('../../fleet-dashboard/lib/api/client')],
  ['tracker', () => import('../../tracker-app/lib/api/client')],
] as const) {
  it(`${name} preserves anonymous access, refresh, account switches and Axios errors without local token plumbing`, async () => {
    const { default: client, setOxyServices } = await load();
    const oxy = new OxyServices({ baseURL: endpoint.origin, enableCache: false });
    setOxyServices(oxy);
    try {
      const anonymous = await client.get('/lookup', { params: { tracking: 'A B' } });
      expect(anonymous.data).toEqual({
        authorization: null,
        cookie: null,
        path: '/lookup?tracking=A+B',
      });
      const firstToken = token('account-a');
      oxy.session.setAccessToken(firstToken);
      expect(
        (
          await client.get('/same', {
            headers: { Authorization: 'Bearer forged', Cookie: 'stale=secret' },
          })
        ).data,
      ).toMatchObject({ authorization: `Bearer ${firstToken}`, cookie: null });
      oxy.session.setAccessToken(token('account-b'));
      const currentToken = token('account-b');
      oxy.session.setAccessToken(currentToken);
      expect((await client.get('/same')).data.authorization).toBe(`Bearer ${currentToken}`);
      const fresh = token('account-b', 1);
      const refresh = vi.fn(async () => fresh);
      oxy.http.setAuthRefreshHandler(refresh);
      rejectNext = true;
      expect((await client.get('/refresh')).data.authorization).toBe(`Bearer ${fresh}`);
      expect(refresh).toHaveBeenCalledTimes(1);
      await expect(client.get('/forbidden')).rejects.toMatchObject({
        response: { status: 403, data: { message: 'resource denied' } },
      });
      const before = requests;
      await expect(client.get('https://foreign.invalid/private')).rejects.toBeDefined();
      const signal = AbortSignal.abort();
      await expect(client.get('/canceled', { signal })).rejects.toBeDefined();
      expect(requests).toBe(before);
      oxy.http.clearTokens();
      expect((await client.get('/lookup')).data.authorization).toBeNull();
    } finally {
      oxy.dispose();
    }
  });
}

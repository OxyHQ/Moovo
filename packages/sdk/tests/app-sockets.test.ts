import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { Server } from 'socket.io';
import { createSessionSocket } from '../../../shared/session-socket';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const token = (id: string, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Socket lifecycle did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setup() {
  const http = createServer();
  const server = new Server(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL, enableCache: false });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => oxy.dispose());
  return { server, oxy, baseURL };
}
it('shared app sockets refresh on handshake/reconnect, fence live events and close immediately on switch/logout', async () => {
  const { server, oxy, baseURL } = await setup();
  oxy.session.setAccessToken(token('a', 1));
  const fresh = token('a');
  let refreshes = 0;
  oxy.http.setAuthRefreshHandler(async () => {
    refreshes++;
    return fresh;
  });
  const handshakes: string[] = [];
  server.on('connection', (socket) => {
    handshakes.push(socket.handshake.auth.token);
  });
  const first = createSessionSocket(oxy, baseURL);
  cleanups.push(first.dispose);
  const updates: string[] = [];
  first.socket.on('notification', () => {
    if (first.isCurrent()) updates.push('a');
  });
  first.connect();
  await until(() => first.socket.connected);
  expect(refreshes).toBe(1);
  server.emit('notification');
  await until(() => updates.length === 1);
  for (const socket of server.sockets.sockets.values()) socket.conn.close();
  await until(() => handshakes.length === 2 && first.socket.connected);
  expect(handshakes).toEqual([fresh, fresh]);
  const nextToken = token('b');
  oxy.session.setAccessToken(nextToken);
  expect(first.socket.connected).toBe(false);
  expect(first.isCurrent()).toBe(false);
  server.emit('notification');
  const second = createSessionSocket(oxy, baseURL);
  cleanups.push(second.dispose);
  second.connect();
  await until(() => second.socket.connected);
  expect(handshakes.at(-1)).toBe(nextToken);
  expect(updates).toEqual(['a']);
  oxy.session.clear();
  expect(second.socket.connected).toBe(false);
  expect(second.isCurrent()).toBe(false);
});
it('unmount or account switch while refresh is pending never dials with the late token', async () => {
  for (const change of ['dispose', 'switch'] as const) {
    const { server, oxy, baseURL } = await setup();
    oxy.session.setAccessToken(token('a', 1));
    let resolve: ((value: string) => void) | undefined;
    oxy.http.setAuthRefreshHandler(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    let connected = 0;
    server.on('connection', () => {
      connected++;
    });
    const connection = createSessionSocket(oxy, baseURL);
    cleanups.push(connection.dispose);
    connection.connect();
    await until(() => Boolean(resolve));
    if (change === 'dispose') connection.dispose();
    else oxy.session.setAccessToken(token('b'));
    resolve?.(token('a'));
    await new Promise((done) => setTimeout(done, 40));
    expect(connected).toBe(0);
    expect(connection.isCurrent()).toBe(false);
  }
});

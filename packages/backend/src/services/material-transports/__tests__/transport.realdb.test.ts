import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from '@playwright/test';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { OxyServices } from '@oxy.so/core';
import { moovoForOxy, createMoovoClient } from '@oxy.so/moovo-sdk';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import {
  materialTransports,
  shipmentBookingAttempts,
} from '../../../db/schema/material-transports';
import { quotes, jobs, providers } from '../../../db/schema/transport';
import { quoteTransport } from '../service';
import { bookShipment, reconcileExternalBooking } from '../../job.service';
import { reconcileUnknownBookings } from '../../booking-reconciler';
import type { ProviderBooking } from '../../providers/provider-adapter';
import { createShipment } from '../../shipment.service';
import { insertQuotes, listActiveQuotesForShipment } from '../../../db/transport/quoteRepository';
import { registerAdapter } from '../../providers/provider-registry';
import type { TransportCaller } from '../access';
import { NO_FILE_AUTHORITY } from '../../files/file-ownership';

vi.mock('../../../middleware/auth', () => ({
  oxyClient: {
    middleware: { auth: () => (_req: Request, _res: Response, next: NextFunction) => next() },
  },
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    const token = tokenName(req.headers.authorization);
    if (
      token &&
      [
        'donor',
        'recipient',
        'sponsor-owner',
        'sponsor-editor',
        'sponsor-removed',
        'stranger',
      ].includes(token)
    )
      Object.assign(req, {
        userId: token.startsWith('sponsor') ? 'sponsor' : token,
        accessToken: req.headers.authorization?.slice(7),
        user: { id: token },
        oxyActor: {
          actorAccountId: token,
          effectiveAccountId: token.startsWith('sponsor') ? 'sponsor' : token,
          delegated: token.startsWith('sponsor'),
        },
      });
    next();
  },
}));
function token(name: string) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: name, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test-signature`;
}
function tokenName(value?: string) {
  try {
    return JSON.parse(
      Buffer.from(value?.replace('Bearer ', '').split('.')[1] ?? '', 'base64url').toString(),
    ).sub;
  } catch {
    return '';
  }
}
const servers: Server[] = [];
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
let suite: SuiteDatabase;
let api: string;
let browserOrigin: string;
const state = new Map<string, string>();
const sourceTokens: string[] = [];
const end = {
  address: { line1: 'Test street 1', city: 'Barcelona', postalCode: '08001', country: 'ES' },
  contactName: 'Test',
  contactPhone: '+34000000000',
  latitude: 41.38,
  longitude: 2.17,
};
const input = (id: string, payer = 'donor') => ({
  reservationId: id,
  actingAccountId: 'donor',
  payerAccountId: payer,
  operationId: `operation_${id}`,
  pickup: end,
  dropoff: { ...end, latitude: 41.4 },
  parcel: { weightKg: 2, pieces: 1, sizeClass: 'small' as const },
  itemDescription: 'Donated boards',
});
const client = (name: string) =>
  createMoovoClient({ apiBaseUrl: api, getAccessToken: () => token(name) }).transports;
const caller: TransportCaller = {
  accountId: 'donor',
  actorAccountId: 'donor',
  delegated: false,
  accessToken: token('donor'),
};
beforeAll(async () => {
  suite = await createSuiteDatabase();
  const source = express();
  source.get('/public/v1/materials/reservations/:id', (req, res) => {
    sourceTokens.push(req.headers.authorization ?? '');
    if (
      !['donor', 'recipient'].includes(tokenName(req.headers.authorization)) ||
      !['donor', 'recipient'].includes(String(req.query.accountId))
    ) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    res.json({
      id: req.params.id,
      offerId: 'offer',
      donorAccountId: 'donor',
      requesterAccountId: 'recipient',
      quantity: 3,
      status: state.get(req.params.id) ?? 'accepted',
      pickupInstructions: 'PRIVATE_SOURCE_ONLY',
      moovoTransportId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  source.get('/cors-test', (_req, res) =>
    res.type('html').send('<!doctype html><title>Transport CORS verification</title>'),
  );
  source.get('/accounts/:id', (req, res) => {
    const token = tokenName(req.headers.authorization);
    if (req.params.id !== 'sponsor' || !token?.startsWith('sponsor')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({
      account: {
        accountId: 'sponsor',
        kind: 'organization',
        relationship: token === 'sponsor-owner' ? 'owner' : 'member',
        ...(token === 'sponsor-owner'
          ? {}
          : {
              callerMembership: {
                role: 'editor',
                status: token === 'sponsor-removed' ? 'removed' : 'active',
              },
            }),
      },
    });
  });
  const base = await listen(source);
  browserOrigin = base;
  process.env.MERCARIA_API_URL = base;
  process.env.OXY_API_URL = base;
  const app = express();
  const { default: router } = await import('../../../routes/material-transports');
  app.use('/api/v1', router);
  api = await listen(app);
}, 30000);
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await destroySuiteDatabase(suite);
});

describe('real transport HTTP, SDK, Oxy-linked source reads and PostgreSQL', () => {
  it('allows canonical Mercaria bearer preflights and exposes both success and error responses without cookies', async () => {
    const preflight = await fetch(`${api}/api/v1/transports`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mercaria.co',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://mercaria.co');
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    for (const bearer of [token('donor'), 'invalid']) {
      const response = await fetch(`${api}/api/v1/transports`, {
        method: 'POST',
        headers: {
          Origin: 'https://mercaria.co',
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input('cors')),
      });
      expect(response.status).toBe(bearer === 'invalid' ? 401 : 201);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://mercaria.co');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
  it.skipIf(process.env.MOOVO_TEST_BROWSER !== '1')(
    'reads real API responses after browser-enforced cross-origin preflight',
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`${browserOrigin}/cors-test`);
        const results = await page.evaluate(
          async ({ api, body, bearer }) => {
            const results: { status: number; amount?: number; error?: string }[] = [];
            for (const auth of [bearer, 'invalid']) {
              const response = await fetch(`${api}/api/v1/transports`, {
                method: 'POST',
                credentials: 'omit',
                headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              const data = (await response.json()) as {
                quotes?: { amountMinor: number }[];
                error?: { code: string };
              };
              results.push({
                status: response.status,
                amount: data.quotes?.[0]?.amountMinor,
                error: data.error?.code,
              });
            }
            return results;
          },
          { api, body: input('browser-cors'), bearer: token('donor') },
        );
        expect(results[0].status).toBe(201);
        expect(results[0].amount).toBeGreaterThan(0);
        expect(results[1]).toMatchObject({ status: 401, error: 'unauthorized' });
      } finally {
        await browser.close();
      }
    },
  );
  it('maps raw HTTP validation errors from the owning contracts and malformed JSON', async () => {
    for (const [body, code] of [
      ['{', 'bad_request'],
      [JSON.stringify({ ...input('invalid'), extra: true }), 'bad_request'],
      [
        JSON.stringify({
          ...input('invalid'),
          parcel: { weightKg: -1, pieces: 1, sizeClass: 'small' },
        }),
        'validation_failed',
      ],
    ]) {
      const response = await fetch(`${api}/api/v1/transports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token('donor')}`, 'Content-Type': 'application/json' },
        body,
      });
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(response.status).toBeLessThan(500);
    }
  });
  it('deduplicates concurrent creation, requires exact payer consent and produces one real courier job with pending payment', async () => {
    const api = client('donor');
    const body = input('concurrent');
    const rows = await Promise.all(Array.from({ length: 8 }, () => api.create(body)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    const request = await api.get(rows[0].id, 'donor');
    expect(request.quotes).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain('PRIVATE_SOURCE_ONLY');
    const [stored] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.id, request.id));
    await expect(
      bookShipment('donor', stored.shipmentId, request.quotes[0].id, 'bypass_key'),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(api.book(request.id, { actingAccountId: 'donor' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const quote = request.quotes[0];
    const auth = {
      actingAccountId: 'donor',
      quoteId: quote.id,
      amountMinor: quote.amountMinor,
      currency: 'FAIR' as const,
      confirmed: true as const,
    };
    await expect(
      client('recipient').authorize(request.id, { ...auth, actingAccountId: 'recipient' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.authorize(request.id, { ...auth, amountMinor: quote.amountMinor + 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const authorized = await api.authorize(request.id, auth);
    expect(authorized.status).toBe('authorized');
    const bookings = await Promise.allSettled(
      Array.from({ length: 8 }, () => api.book(request.id, { actingAccountId: 'donor' })),
    );
    expect(bookings.some((r) => r.status === 'fulfilled')).toBe(true);
    const booked = await api.book(request.id, { actingAccountId: 'donor' });
    expect(booked).toMatchObject({
      status: 'booked',
      paymentStatus: 'pending',
      paymentCollectionAvailable: false,
    });
    expect(booked.jobId).toBeTruthy();
    expect(
      await suite.db.select().from(jobs).where(eq(jobs.shipmentId, stored.shipmentId)),
    ).toHaveLength(1);
    state.set(body.reservationId, 'cancelled');
    expect((await api.byReservation(body.reservationId, 'donor')).jobId).toBe(booked.jobId);
    await expect(api.cancel(request.id, { actingAccountId: 'donor' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(sourceTokens.map(tokenName)).toContain('donor');
  });
  it('lets only the selected payer owner authorize, and makes a source participant perform booking after sponsor consent', async () => {
    const api = client('donor');
    const request = await api.create(input('sponsored', 'sponsor'));
    const quote = request.quotes[0];
    const auth = {
      actingAccountId: 'sponsor',
      quoteId: quote.id,
      amountMinor: quote.amountMinor,
      currency: 'FAIR' as const,
      confirmed: true as const,
    };
    await expect(client('sponsor-editor').authorize(request.id, auth)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(client('sponsor-removed').get(request.id, 'sponsor')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const approved = await client('sponsor-owner').authorize(request.id, auth);
    expect(approved.authorization?.actorAccountId).toBe('sponsor-owner');
    await expect(
      client('sponsor-owner').book(request.id, { actingAccountId: 'sponsor' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    state.set('sponsored', 'cancelled');
    await expect(api.book(request.id, { actingAccountId: 'donor' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await api.cancel(request.id, { actingAccountId: 'donor' })).status).toBe('cancelled');
  });
  it('recovers lost quote responses and a crashed quoting worker on the same shipment', async () => {
    const api = client('donor');
    const request = await api.create(input('quote-recovery'));
    const [row] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.id, request.id));
    await suite.db
      .update(materialTransports)
      .set({ status: 'quoting' })
      .where(eq(materialTransports.id, row.id));
    expect((await api.create(input('quote-recovery'))).status).toBe('quoted');
    await suite.db
      .update(quotes)
      .set({ expiresAt: new Date(0) })
      .where(eq(quotes.shipmentId, row.shipmentId));
    await suite.db
      .update(materialTransports)
      .set({ status: 'quoting', updatedAt: new Date(0) })
      .where(eq(materialTransports.id, row.id));
    const recovered = await quoteTransport(caller, row.id, 'donor');
    expect(recovered.quotes).toHaveLength(1);
    expect(recovered.quotes[0].id).not.toBe(request.quotes[0].id);
    expect(
      (await suite.db.select().from(materialTransports).where(eq(materialTransports.id, row.id)))[0]
        .shipmentId,
    ).toBe(row.shipmentId);
  });
  it('keeps cancellation replay cancelled, permits an explicit new request, and binds operation IDs to content', async () => {
    const api = client('donor');
    const body = input('cancelled');
    const first = await api.create(body);
    await api.cancel(first.id, { actingAccountId: 'donor' });
    expect((await api.create(body)).status).toBe('cancelled');
    await expect(api.create({ ...body, itemDescription: 'Changed' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const next = await api.create({ ...body, operationId: 'explicit_new_operation' });
    expect(next.id).not.toBe(first.id);
    expect((await api.byReservation(body.reservationId, 'donor')).id).toBe(next.id);
  });
  it('clears expired authorization when renewing, and cannot authorize a stale price', async () => {
    const api = client('donor');
    const row = await api.create(input('expire'));
    const q = row.quotes[0];
    await api.authorize(row.id, {
      actingAccountId: 'donor',
      quoteId: q.id,
      amountMinor: q.amountMinor,
      currency: 'FAIR',
      confirmed: true,
    });
    const [stored] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.id, row.id));
    await suite.db
      .update(quotes)
      .set({ expiresAt: new Date(0) })
      .where(eq(quotes.shipmentId, stored.shipmentId));
    await suite.db
      .update(materialTransports)
      .set({ authorizationExpiresAt: new Date(0) })
      .where(eq(materialTransports.id, row.id));
    await expect(api.book(row.id, { actingAccountId: 'donor' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const renewed = await api.quote(row.id, { actingAccountId: 'donor' });
    expect(renewed.authorization).toBeNull();
    expect(renewed.status).toBe('quoted');
    await expect(
      api.authorize(row.id, {
        actingAccountId: 'donor',
        quoteId: q.id,
        amountMinor: q.amountMinor,
        currency: 'FAIR',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retries a failed quote write on the same durable shipment', async () => {
    await suite.db.execute(
      sql`CREATE FUNCTION fail_transport_quote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected quote write failure'; END $$`,
    );
    await suite.db.execute(
      sql`CREATE TRIGGER fail_transport_quote BEFORE INSERT ON quotes FOR EACH STATEMENT EXECUTE FUNCTION fail_transport_quote()`,
    );
    const api = client('donor');
    try {
      await expect(api.create(input('quote-failed'))).rejects.toMatchObject({
        code: 'internal_error',
      });
    } finally {
      await suite.db.execute(sql`DROP TRIGGER fail_transport_quote ON quotes`);
      await suite.db.execute(sql`DROP FUNCTION fail_transport_quote()`);
    }
    const [before] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.reservationId, 'quote-failed'));
    const recovered = await api.create(input('quote-failed'));
    expect(recovered.id).toBe(before.id);
    expect(recovered.quotes).toHaveLength(1);
    const [after] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.id, before.id));
    expect(after.shipmentId).toBe(before.shipmentId);
  });
  it('resolves a discarded HTTP create response through the linked SDK without issuing another create', async () => {
    const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'http://127.0.0.1' });
    oxy.session.setAccessToken(token('donor'));
    const linked = moovoForOxy(oxy, { apiBaseUrl: api });
    const response = await fetch(`${api}/api/v1/transports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token('donor')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input('lost-response')),
    });
    expect(response.status).toBe(201);
    await response.arrayBuffer();
    expect((await linked.transports.byReservation('lost-response', 'donor')).id).toBeTruthy();
    linked.dispose();
    oxy.dispose();
  });
  it('recovers a crashed internal booking with a deterministic key, and refuses direct booking during its lease', async () => {
    const api = client('donor');
    const proposal = await api.create(input('booking-crash'));
    const q = proposal.quotes[0];
    await api.authorize(proposal.id, {
      actingAccountId: 'donor',
      quoteId: q.id,
      amountMinor: q.amountMinor,
      currency: 'FAIR',
      confirmed: true,
    });
    const [stored] = await suite.db
      .select()
      .from(materialTransports)
      .where(eq(materialTransports.id, proposal.id));
    await suite.db
      .update(materialTransports)
      .set({ status: 'booking', updatedAt: new Date(0) })
      .where(eq(materialTransports.id, proposal.id));
    await suite.db.insert(shipmentBookingAttempts).values({
      shipmentId: stored.shipmentId,
      quoteId: q.id,
      senderAccountId: 'donor',
      operationId: `shipment_${stored.shipmentId}`,
      status: 'processing',
      createdAt: new Date(0),
    });
    await expect(
      bookShipment('donor', stored.shipmentId, q.id, `material_${proposal.id}`),
    ).rejects.toMatchObject({ httpStatus: 403 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => api.book(proposal.id, { actingAccountId: 'donor' })),
    );
    expect(attempts.some((result) => result.status === 'fulfilled')).toBe(true);
    const recovered = await api.book(proposal.id, { actingAccountId: 'donor' });
    expect(recovered.jobId).toBeTruthy();
    expect(
      await suite.db.select().from(jobs).where(eq(jobs.shipmentId, stored.shipmentId)),
    ).toHaveLength(1);
  });
  it('rolls back internal booking admission with the job so a failed transaction can retry immediately', async () => {
    const body = input('atomic-admission');
    const shipment = await createShipment(
      'donor',
      {
        type: 'package',
        pickup: { ...body.pickup, location: { type: 'Point', coordinates: [2.17, 41.38] } },
        dropoff: { ...body.dropoff, location: { type: 'Point', coordinates: [2.17, 41.4] } },
        parcel: body.parcel,
        itemDescription: 'Atomic internal booking',
      },
      NO_FILE_AUTHORITY,
    );
    const [quote] = await listActiveQuotesForShipment(shipment.id);
    await suite.db.execute(
      sql`CREATE FUNCTION fail_internal_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected job write failure'; END $$`,
    );
    await suite.db.execute(
      sql`CREATE TRIGGER fail_internal_job BEFORE INSERT ON jobs FOR EACH STATEMENT EXECUTE FUNCTION fail_internal_job()`,
    );
    try {
      await expect(
        bookShipment('donor', shipment.id, quote.id, 'atomic_admission'),
      ).rejects.toThrow();
    } finally {
      await suite.db.execute(sql`DROP TRIGGER fail_internal_job ON jobs`);
      await suite.db.execute(sql`DROP FUNCTION fail_internal_job()`);
    }
    expect(
      await suite.db
        .select()
        .from(shipmentBookingAttempts)
        .where(eq(shipmentBookingAttempts.shipmentId, shipment.id)),
    ).toHaveLength(0);
    const booked = await bookShipment('donor', shipment.id, quote.id, 'atomic_admission');
    expect((await bookShipment('donor', shipment.id, quote.id, 'atomic_admission')).id).toBe(
      booked.id,
    );
    expect(await suite.db.select().from(jobs).where(eq(jobs.shipmentId, shipment.id))).toHaveLength(
      1,
    );
  });
  it('claims external provider booking before I/O, never repeats a lost reply, and reconciles it by operation id', async () => {
    const body = input('external');
    const shipment = await createShipment(
      'donor',
      {
        type: 'package',
        pickup: { ...body.pickup, location: { type: 'Point', coordinates: [2.17, 41.38] } },
        dropoff: { ...body.dropoff, location: { type: 'Point', coordinates: [2.17, 41.4] } },
        parcel: body.parcel,
        itemDescription: 'Provider test',
      },
      NO_FILE_AUTHORITY,
    );
    const [internal] = await listActiveQuotesForShipment(shipment.id);
    const providerId = crypto.randomUUID();
    await suite.db
      .insert(providers)
      .values({ id: providerId, key: 'lost-reply', name: 'Test carrier', enabled: false });
    let effects = 0;
    let operation = '';
    // What the carrier holds per operation id, and how its next reply goes:
    // lost before it booked, lost after it booked, or delivered.
    const held = new Map<string, ProviderBooking>();
    let reply: 'lost-before' | 'lost-after' | 'ok' = 'lost-before';
    registerAdapter({
      key: 'lost-reply',
      quote: async () => [],
      book: async (_s, _q, context) => {
        effects++;
        operation = context.operationId;
        if (reply === 'lost-before') throw new Error('carrier response lost after booking');
        const booking = { bookingRef: `ref-${context.operationId}` };
        held.set(context.operationId, booking);
        if (reply === 'lost-after') throw new Error('carrier response lost after booking');
        return booking;
      },
      findBooking: async (operationId) => held.get(operationId) ?? null,
    });
    const age = (shipmentId: string) =>
      suite.db
        .update(shipmentBookingAttempts)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(shipmentBookingAttempts.shipmentId, shipmentId));
    const [quote] = await insertQuotes([
      {
        shipmentId: shipment.id,
        source: 'external_provider',
        providerId,
        priceBreakdown: internal.priceBreakdown,
        expiresAt: new Date(Date.now() + 60000),
        status: 'active',
      },
    ]);
    await expect(
      bookShipment('donor', shipment.id, quote.id, 'provider_operation'),
    ).rejects.toThrow('response lost');
    await expect(
      bookShipment('donor', shipment.id, quote.id, 'different_operation'),
    ).rejects.toMatchObject({ httpStatus: 409 });
    const other = await createShipment(
      'donor',
      {
        type: 'package',
        pickup: { ...body.pickup, location: { type: 'Point', coordinates: [2.17, 41.38] } },
        dropoff: { ...body.dropoff, location: { type: 'Point', coordinates: [2.17, 41.4] } },
        parcel: body.parcel,
        itemDescription: 'Different shipment, reused operation',
      },
      NO_FILE_AUTHORITY,
    );
    const [otherQuote] = await insertQuotes([
      {
        shipmentId: other.id,
        source: 'external_provider',
        providerId,
        priceBreakdown: internal.priceBreakdown,
        expiresAt: new Date(Date.now() + 60000),
        status: 'active',
      },
    ]);
    await expect(
      bookShipment('donor', other.id, otherQuote.id, 'provider_operation'),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(effects).toBe(1);
    expect(operation).toBe(`shipment_${shipment.id}`);
    expect(
      (
        await suite.db
          .select()
          .from(shipmentBookingAttempts)
          .where(eq(shipmentBookingAttempts.shipmentId, shipment.id))
      )[0].status,
    ).toBe('unknown');

    // Inside the window nobody asks: the lookup must not race the request.
    expect(await reconcileExternalBooking(shipment.id)).toEqual({ kind: 'pending' });
    // Past it, a carrier holding nothing frees the shipment for a new attempt,
    // booked under a new operation id.
    await age(shipment.id);
    expect(await reconcileExternalBooking(shipment.id)).toEqual({ kind: 'failed' });
    reply = 'ok';
    const rebooked = await bookShipment('donor', shipment.id, quote.id, 'provider_operation');
    expect(rebooked.providerRef).toBe(`ref-shipment_${shipment.id}_2`);

    // A reply lost AFTER the carrier booked becomes that booking's job, even
    // once the quote row has been reaped.
    const third = await createShipment(
      'donor',
      {
        type: 'package',
        pickup: { ...body.pickup, location: { type: 'Point', coordinates: [2.17, 41.38] } },
        dropoff: { ...body.dropoff, location: { type: 'Point', coordinates: [2.17, 41.4] } },
        parcel: body.parcel,
        itemDescription: 'Booked, reply lost',
      },
      NO_FILE_AUTHORITY,
    );
    const [thirdQuote] = await insertQuotes([
      {
        shipmentId: third.id,
        source: 'external_provider',
        providerId,
        priceBreakdown: internal.priceBreakdown,
        expiresAt: new Date(Date.now() + 60000),
        status: 'active',
      },
    ]);
    reply = 'lost-after';
    await expect(bookShipment('donor', third.id, thirdQuote.id, 'third_operation')).rejects.toThrow(
      'response lost',
    );
    await suite.db.delete(quotes).where(eq(quotes.id, thirdQuote.id));
    await age(third.id);
    const outcomes = await reconcileUnknownBookings();
    expect(outcomes.map((o) => o.kind)).toContain('booked');
    const thirdJobs = await suite.db.select().from(jobs).where(eq(jobs.shipmentId, third.id));
    expect(thirdJobs).toHaveLength(1);
    expect(thirdJobs[0].providerRef).toBe(`ref-shipment_${third.id}`);
    expect((await bookShipment('donor', third.id, thirdQuote.id, 'third_operation')).id).toBe(
      thirdJobs[0].id,
    );
  });
});

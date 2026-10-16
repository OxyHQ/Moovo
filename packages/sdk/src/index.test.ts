import { describe, expect, it } from 'vitest';
import { createMoovoClient, formatTransportPrice } from './index';

describe('transport SDK public boundary', () => {
  it('formats Moovo FAIR cents without adopting another product money scale', () => {
    expect(formatTransportPrice({ amountMinor: 1234, currency: 'FAIR' }, 'en-US')).toBe(
      '12.34 FAIR',
    );
    expect(formatTransportPrice({ amountMinor: 1234, currency: 'FAIR' }, 'es-ES')).toBe(
      '12,34 FAIR',
    );
    expect(() => formatTransportPrice({ amountMinor: -1, currency: 'FAIR' }, 'en-US')).toThrow();
  });
  it('rejects traversal and missing human confirmation before any request', () => {
    const client = createMoovoClient({
      getAccessToken: () => 'test',
      fetch: async () => {
        throw new Error('must not send');
      },
    });
    expect(() => client.transports.get('..', 'donor')).toThrow();
    expect(() =>
      client.transports.authorize('transport', {
        actingAccountId: 'donor',
        quoteId: 'quote',
        amountMinor: 1234,
        currency: 'FAIR',
        confirmed: false as true,
      }),
    ).toThrow();
  });
  it('never silently retries a write after losing its response', async () => {
    let calls = 0;
    const client = createMoovoClient({
      getAccessToken: () => 'test',
      fetch: async () => {
        calls++;
        throw new Error('response lost');
      },
    });
    await expect(client.transports.book('transport', { actingAccountId: 'donor' })).rejects.toThrow(
      'response lost',
    );
    expect(calls).toBe(1);
  });
});

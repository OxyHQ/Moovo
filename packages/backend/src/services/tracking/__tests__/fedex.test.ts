/**
 * The FedEx mapping.
 *
 * **What these fixtures can and cannot prove.** They are written to FedEx's
 * published Track API v1 shape, so they pin THIS FILE'S READING of that shape —
 * that a delivered result becomes `delivered`, that scan events come out
 * ascending, that an unknown number becomes `notFound` rather than an error.
 * They cannot prove FedEx sends these field names. Only one live call with real
 * credentials can, and until that has happened `tracking_carriers.poll_supported`
 * stays false on the `fedex` row. See the header of `adapters/fedex.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFedexAdapter,
  firstTrackResult,
  toSnapshot,
  type FedexTrackResult,
} from '../adapters/fedex.js';

const DELIVERED: FedexTrackResult = {
  latestStatusDetail: { code: 'DL', derivedCode: 'DL', description: 'Delivered' },
  serviceDetail: { description: 'FedEx International Priority' },
  shipperInformation: { address: { countryCode: 'US' } },
  recipientInformation: { address: { countryCode: 'ES' } },
  dateAndTimes: [
    { type: 'ESTIMATED_DELIVERY', dateTime: '2026-09-05T12:00:00-06:00' },
    { type: 'ACTUAL_DELIVERY', dateTime: '2026-09-05T10:41:00-06:00' },
  ],
  // Newest first, as FedEx returns them.
  scanEvents: [
    {
      date: '2026-09-05T10:41:00-06:00',
      eventType: 'DL',
      derivedStatusCode: 'DL',
      eventDescription: 'Delivered',
      scanLocation: { city: 'MADRID', stateOrProvinceCode: 'M', countryCode: 'ES' },
    },
    {
      date: '2026-09-05T07:02:00-06:00',
      eventType: 'OD',
      derivedStatusCode: 'OD',
      eventDescription: 'On FedEx vehicle for delivery',
      scanLocation: { city: 'MADRID', countryCode: 'ES' },
    },
    {
      date: '2026-09-03T21:15:00-06:00',
      eventType: 'PU',
      derivedStatusCode: 'IN',
      eventDescription: 'Picked up',
      scanLocation: { city: 'MEMPHIS', stateOrProvinceCode: 'TN', countryCode: 'US' },
    },
  ],
};

describe('toSnapshot', () => {
  it('maps the derived code, the dates and the endpoints', () => {
    const snapshot = toSnapshot(DELIVERED);
    expect(snapshot.status).toBe('delivered');
    expect(snapshot.rawStatus).toBe('DL');
    expect(snapshot.serviceName).toBe('FedEx International Priority');
    expect(snapshot.originCountry).toBe('US');
    expect(snapshot.destinationCountry).toBe('ES');
    expect(snapshot.deliveredAt?.toISOString()).toBe('2026-09-05T16:41:00.000Z');
    expect(snapshot.estimatedDeliveryAt?.toISOString()).toBe('2026-09-05T18:00:00.000Z');
  });

  it('returns checkpoints ASCENDING even though FedEx sends them newest first', () => {
    // Sorted rather than reversed. Relying on the carrier's ordering would put
    // every timeline backwards on the day they change it, silently.
    const times = toSnapshot(DELIVERED).checkpoints.map((c) => c.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(toSnapshot(DELIVERED).checkpoints[0]?.description).toBe('Picked up');
  });

  it('keeps the offset, so a checkpoint is a true instant and not local time', () => {
    // FedEx sends an offset, so nothing is guessed. The flag exists for the
    // carriers that do not, and it must not be set here.
    expect(toSnapshot(DELIVERED).checkpoints.every((c) => c.occurredAtIsLocal === false)).toBe(
      true,
    );
  });

  it('reports a timestamp with NO offset as local rather than inventing UTC', () => {
    const snapshot = toSnapshot({
      latestStatusDetail: { derivedCode: 'IT' },
      scanEvents: [{ date: '2026-09-05T10:41:00', derivedStatusCode: 'IT' }],
    });
    expect(snapshot.checkpoints[0]?.occurredAtIsLocal).toBe(true);
  });

  it('turns an unknown number into notFound, NOT into an error', () => {
    // A label created and never scanned is the commonest thing anyone pastes.
    // As an error it would enter backoff and stay there; as this it expires.
    const snapshot = toSnapshot({ error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND' } });
    expect(snapshot.notFound).toBe(true);
    expect(snapshot.status).toBe('pending');
    expect(snapshot.checkpoints).toEqual([]);
  });

  it('falls back to in_transit for a code it does not know, keeping the raw one', () => {
    // Never `exception`: an unrecognised code is OUR gap, and telling a customer
    // their parcel has a problem on that basis is worse than saying it moves.
    const snapshot = toSnapshot({ latestStatusDetail: { derivedCode: 'ZZ' } });
    expect(snapshot.status).toBe('in_transit');
    expect(snapshot.rawStatus).toBe('ZZ');
  });

  it('drops a scan event with an unparseable date instead of emitting Invalid Date', () => {
    const snapshot = toSnapshot({
      latestStatusDetail: { derivedCode: 'IT' },
      scanEvents: [{ date: 'not-a-date', derivedStatusCode: 'IT' }, { date: undefined }],
    });
    expect(snapshot.checkpoints).toEqual([]);
  });
});

describe('firstTrackResult', () => {
  it('digs the result out of the envelope', () => {
    expect(
      firstTrackResult({ output: { completeTrackResults: [{ trackResults: [DELIVERED] }] } }),
    ).toBe(DELIVERED);
  });

  it('answers null for an empty envelope rather than throwing', () => {
    expect(firstTrackResult({})).toBeNull();
    expect(firstTrackResult({ output: { completeTrackResults: [] } })).toBeNull();
  });
});

describe('buildFedexAdapter', () => {
  it('is DEEP-LINK-ONLY without credentials, which is the shipped default', () => {
    const adapter = buildFedexAdapter(null);
    expect(adapter.capabilities).toEqual({ fetch: false, webhook: false, deepLinkOnly: true });
    expect(adapter.fetch).toBeUndefined();
  });

  it('gains fetch only when a COMPLETE credential pair is present', () => {
    const adapter = buildFedexAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: 'https://apis-sandbox.fedex.com',
    });
    expect(adapter.capabilities.fetch).toBe(true);
    expect(adapter.capabilities.deepLinkOnly).toBe(false);
    expect(typeof adapter.fetch).toBe('function');
  });

  it('detects and deep-links identically either way', () => {
    // The credential switch must change what we can FETCH and nothing else.
    // A number that resolved to FedEx yesterday has to resolve to FedEx today.
    const off = buildFedexAdapter(null);
    const on = buildFedexAdapter({ clientId: 'i', clientSecret: 's', baseUrl: 'https://x' });
    for (const number of ['123456789012', '123456789012345', '1Z999AA10123456784']) {
      expect(off.detect?.(number)).toEqual(on.detect?.(number));
    }
    expect(off.deepLink({ trackingNumber: '123456789012' })).toBe(
      on.deepLink({ trackingNumber: '123456789012' }),
    );
  });
});

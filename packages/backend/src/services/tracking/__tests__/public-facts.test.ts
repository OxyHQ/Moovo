/**
 * What an anonymous lookup may say, compared as an EXACT SET.
 *
 * The direction is the whole point, and it is the same argument
 * `DELIVERY_FACT_KEYS` makes in the moderation domain:
 *
 * A suite of "must not contain `recipientName`" assertions only fails when a
 * field somebody NAMED disappears. It is completely silent about a field
 * somebody ADDS — and that is how every real leak arrives. Nobody sets out to
 * publish a recipient's name; somebody passes a carrier response through a new
 * mapper and a `deliveredTo` rides along beside the fields they meant to add.
 *
 * **When this fails after you added a field, the fix is not to append the key.**
 * Decide first whether a stranger holding only a tracking number may see it.
 */

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CHECKPOINT_FACT_KEYS,
  PUBLIC_PARCEL_FACT_KEYS,
  PUBLIC_PARCEL_REFUSED_FACTS,
} from '../public-facts.js';
import { toPublicLookup } from '../tracking-hydration.service.js';
import type { TrackedParcelRow } from '../../../db/tracking/trackedParcelRepository.js';
import type { TrackingCarrierRow } from '../../../db/tracking/trackingCarrierRepository.js';
import type { TrackingCheckpointRow } from '../../../db/tracking/trackingCheckpointRepository.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/** Every optional field populated, so nothing is absent merely by being unset. */
const parcel = {
  id: 'parcel-1',
  carrierKey: 'ups',
  trackingNumber: '1Z999AA10123456784',
  status: 'delivered',
  rawStatus: 'DELIVERED',
  serviceName: 'UPS Express',
  originCountry: 'DE',
  destinationCountry: 'ES',
  destinationPostalCode: '28013',
  estimatedDeliveryAt: NOW,
  deliveredAt: NOW,
  lastCheckpointAt: NOW,
  checkpointCount: 1,
  subscriberCount: 3,
  pollMode: 'poll',
  nextPollAt: null,
  lastPolledAt: NOW,
  consecutiveFailures: 0,
  notFoundStreak: 0,
  lastPollError: null,
  leaseOwner: null,
  leaseUntil: null,
  moovoJobId: null,
  expiresAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as TrackedParcelRow;

const carrier = {
  id: 'carrier-1',
  key: 'ups',
  name: 'UPS',
  logoFileId: null,
  providerId: null,
  enabled: true,
  sourceKind: 'official_api',
  pollSupported: true,
  webhookSupported: false,
  deepLinkTemplate: 'https://www.ups.com/track?tracknum={number}',
  countryCodes: ['ES'],
  maxCallsPerMinute: null,
  maxCallsPerDay: null,
  maxConcurrent: 2,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as TrackingCarrierRow;

const checkpoint = {
  id: 'cp-1',
  parcelId: 'parcel-1',
  dedupeKey: 'abc',
  status: 'delivered',
  rawStatus: 'DELIVERED',
  description: 'Entregado',
  locationText: 'MADRID',
  countryCode: 'ES',
  // Populated on purpose: a delivered parcel's last coordinate is somebody's
  // doorstep, and this is the field most likely to be passed through by
  // accident.
  latitude: 40.4168,
  longitude: -3.7038,
  location: null,
  occurredAt: NOW,
  occurredAtIsLocal: false,
  receivedAt: NOW,
  createdAt: NOW,
} as unknown as TrackingCheckpointRow;

describe('the public lookup shape', () => {
  const built = toPublicLookup({ parcel, carrier, checkpoints: [checkpoint] });

  it('carries EXACTLY the permitted top-level keys', () => {
    expect(Object.keys(built).sort()).toEqual([...PUBLIC_PARCEL_FACT_KEYS].sort());
  });

  it('carries EXACTLY the permitted checkpoint keys', () => {
    expect(Object.keys(built.checkpoints[0]!).sort()).toEqual(
      [...PUBLIC_CHECKPOINT_FACT_KEYS].sort(),
    );
  });

  it('drops coordinates from a public checkpoint', () => {
    // A depot's NAME is where the parcel was. A coordinate pair plus a
    // timestamp narrows a household, and the last fix on a delivered parcel is
    // a doorstep. The carrier gives us both; only one leaves.
    expect(built.checkpoints[0]).not.toHaveProperty('location');
    expect(built.checkpoints[0]).toHaveProperty('locationText');
  });

  it('never names a person or an address, whatever the carrier sent', () => {
    // A belt to the exact-set braces above. This assertion alone would be the
    // WRONG test — it is silent about anything nobody thought to forbid — but
    // it documents the specific fields the refusal is about.
    const serialised = JSON.stringify(built);
    for (const refused of PUBLIC_PARCEL_REFUSED_FACTS) {
      expect(serialised).not.toContain(refused);
    }
  });

  it('still answers the question the user actually asked', () => {
    // A shape that refuses everything would pass every assertion above.
    expect(built.status).toBe('delivered');
    expect(built.trackingNumber).toBe('1Z999AA10123456784');
    expect(built.trackingUrl).toContain('1Z999AA10123456784');
    expect(built.checkpoints).toHaveLength(1);
    expect(built.checkpoints[0]?.locationText).toBe('MADRID');
  });
});

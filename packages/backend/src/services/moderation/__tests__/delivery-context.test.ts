/**
 * The whole delivery description, checked for leaks.
 *
 * `redaction.test.ts` proves the endpoint reducer is correct in isolation. This
 * proves the thing that is actually SENT carries none of the PII — which is a
 * different claim, because `deliveryFacts` assembles its own object and could
 * reintroduce any field it likes without touching `redactEndpoint` at all.
 *
 * The delivery verification codes get their own assertions. They are the only
 * values here that are not merely private but a CREDENTIAL: the dropoff code is
 * what proves to a courier that the person accepting a parcel is the intended
 * recipient, and a juror who learned one could collect somebody else's delivery.
 * They are excluded at the projection — never loaded from Mongo at all — so
 * these tests seed them on the document anyway and confirm they cannot travel
 * even when they are present in memory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

const jobFindById = vi.fn();
const shipmentFindById = vi.fn();

/** A chainable `findById().select().lean()` returning `value`. */
function query(value: unknown) {
  return { select: () => ({ lean: async () => value }) };
}

vi.mock('../../../models/job.js', () => ({
  Job: { findById: (...args: unknown[]) => jobFindById(...args) },
}));
vi.mock('../../../models/shipment.js', () => ({
  Shipment: { findById: (...args: unknown[]) => shipmentFindById(...args) },
}));

import {
  buildDeliveryContext,
  buildDeliveryResource,
  DELIVERY_FACT_KEYS,
} from '../subjects/delivery-context.js';
import type { ModerationResource } from '../subjects/types.js';

/**
 * The facts bag off a metadata resource.
 *
 * `ModerationResource` is a discriminated union, so reaching for `.data` without
 * narrowing does not compile — which is the contract stopping a test from
 * assuming a shape it has not checked. Asserting the discriminant first is both
 * the fix and an assertion worth making.
 */
function facts(resource: ModerationResource): Record<string, unknown> {
  expect(resource.type).toBe('metadata');
  if (resource.type !== 'metadata') throw new Error('not a metadata resource');
  return resource.data;
}

const VALID_ID = '507f1f77bcf86cd799439011';
/** A real ObjectId, because `SnapshotJob._id` is one and a string is not. */
const OBJECT_ID = new mongoose.Types.ObjectId(VALID_ID);

/** Every value that must never reach a jury, each uniquely searchable. */
const SECRETS = {
  pickupContactName: 'ZZPICKUPNAMEZZ',
  pickupPhone: '+34ZZPICKUPPHONEZZ',
  pickupLine1: 'ZZPICKUPSTREETZZ 1',
  dropoffContactName: 'ZZDROPNAMEZZ',
  dropoffPhone: '+34ZZDROPPHONEZZ',
  dropoffLine1: 'ZZDROPSTREETZZ 9',
  dropoffPostal: 'ZZ08999ZZ',
  pickupCode: 'ZZPICKUPCODEZZ',
  dropoffCode: 'ZZDROPOFFCODEZZ',
  pickupCodeHash: 'ZZPICKUPHASHZZ',
  dropoffCodeHash: 'ZZDROPOFFHASHZZ',
  recipientName: 'ZZRECIPIENTZZ',
  paymentReference: 'ZZPAYREFZZ',
} as const;

function job(overrides: Record<string, unknown> = {}) {
  return {
    _id: OBJECT_ID,
    jobNumber: 'MV-1001',
    shipmentId: VALID_ID,
    senderOxyUserId: 'sender-1',
    courierOxyUserId: 'courier-1',
    type: 'package' as const,
    fulfillmentType: 'moovo_courier' as const,
    status: 'delivered' as const,
    pickupSnapshot: {
      location: { type: 'Point' as const, coordinates: [2.154007, 41.390205] },
      address: {
        line1: SECRETS.pickupLine1,
        city: 'Barcelona',
        region: 'Catalunya',
        postalCode: '08001',
        country: 'ES',
      },
      contactName: SECRETS.pickupContactName,
      contactPhone: SECRETS.pickupPhone,
      notes: 'Collect from reception',
    },
    dropoffSnapshot: {
      location: { type: 'Point' as const, coordinates: [2.170000, 41.400000] },
      address: {
        line1: SECRETS.dropoffLine1,
        city: 'Girona',
        postalCode: SECRETS.dropoffPostal,
        country: 'ES',
      },
      contactName: SECRETS.dropoffContactName,
      contactPhone: SECRETS.dropoffPhone,
      notes: 'Leave with the neighbour',
    },
    parcelSnapshot: { weightKg: 3.5, sizeClass: 'medium' as const, pieces: 1, fragile: true },
    statusHistory: [],
    // Present in memory even though the projection excludes them: the assertions
    // below must hold regardless of how the document was loaded.
    pickupCode: SECRETS.pickupCode,
    dropoffCode: SECRETS.dropoffCode,
    pickupCodeHash: SECRETS.pickupCodeHash,
    dropoffCodeHash: SECRETS.dropoffCodeHash,
    proofOfDelivery: { note: 'Handed over at the door', recipientName: SECRETS.recipientName },
    payment: { status: 'paid', provider: 'oxy_pay', reference: SECRETS.paymentReference },
    createdAt: new Date('2026-07-01T10:00:00Z'),
    ...overrides,
  };
}

function shipment(overrides: Record<string, unknown> = {}) {
  return {
    _id: OBJECT_ID,
    itemDescription: 'A sealed cardboard box, contents unknown',
    photos: [{ fileId: 'file-1', position: 0 }, { fileId: 'file-2', position: 1 }],
    type: 'package' as const,
    distanceM: 12_400,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobFindById.mockReturnValue(query(job()));
  shipmentFindById.mockReturnValue(query(shipment()));
});

describe('the exact key set a delivery may carry', () => {
  /**
   * The assertion that matters most in this file.
   *
   * An exact set comparison, not a list of `not.toHaveProperty` calls. Those only
   * fail when a field they already name goes missing — they are silent about a
   * field ADDED, which is the direction every real leak arrives from: somebody
   * passes an object through, or spreads a document, and a `contactPhone` rides
   * along. A test naming the forbidden fields cannot catch the one nobody has
   * thought of yet. This one catches all of them, including fields that do not
   * exist on the model today.
   *
   * When this fails after you added a field, the fix is not to append the key to
   * `DELIVERY_FACT_KEYS` — it is to decide whether an anonymous stranger reviewing
   * a case may see it, and only then to write it down.
   */
  it('emits nothing outside DELIVERY_FACT_KEYS', async () => {
    const emitted = Object.keys(facts(await buildDeliveryResource(job()))).sort();
    expect(emitted).toEqual([...DELIVERY_FACT_KEYS].sort());
  });

  it('holds every optional key too, so the comparison above is not partial', async () => {
    // The fixture is deliberately fully populated: notes on both endpoints, a
    // proof-of-delivery note, a fragile parcel, a distance, an assigned courier.
    // If it were sparse, the set comparison would silently exempt whichever keys
    // it failed to produce.
    expect(DELIVERY_FACT_KEYS.length).toBe(16);
    const emitted = Object.keys(facts(await buildDeliveryResource(job())));
    expect(emitted).toHaveLength(DELIVERY_FACT_KEYS.length);
  });
});

describe('buildDeliveryResource', () => {
  it('describes the delivery as a bounded scalar metadata resource', async () => {
    const resource = await buildDeliveryResource(job());

    expect(resource.type).toBe('metadata');
    // The contract refuses a nested structure here, which is what stops a whole
    // Job document being posted through this field. Assert it directly.
    for (const value of Object.values(facts(resource))) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('carries the material a jury actually needs', async () => {
    const data = facts(await buildDeliveryResource(job()));

    expect(data.itemDescription).toBe('A sealed cardboard box, contents unknown');
    expect(data.deliveryType).toBe('package');
    expect(data.status).toBe('delivered');
    expect(data.pickupArea).toBe('Barcelona, Catalunya, ES');
    expect(data.dropoffArea).toBe('Girona, ES');
    expect(data.dropoffNotes).toBe('Leave with the neighbour');
    expect(data.courierAssigned).toBe(true);
  });

  it('declares photo evidence exists without attaching it', async () => {
    const data = facts(await buildDeliveryResource(job()));
    // A jury that can see material exists which it was not given can answer
    // `insufficient_context` for the right reason rather than by accident.
    expect(data.photoCount).toBe(2);
  });

  describe('carries none of the private values', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      it(`never carries ${name}`, async () => {
        const serialised = JSON.stringify(await buildDeliveryResource(job()));
        expect(serialised).not.toContain(secret);
      });
    }

    it('never carries either endpoint coordinate', async () => {
      const serialised = JSON.stringify(await buildDeliveryResource(job()));
      expect(serialised).not.toContain('41.39');
      expect(serialised).not.toContain('41.4');
      expect(serialised).not.toContain('2.15');
      expect(serialised).not.toContain('2.17');
    });
  });

  it('reports courierAssigned false when no courier ever accepted', async () => {
    // A complaint about a courier on a job no courier was assigned to is a
    // different — and usually mistaken — claim, and a jury cannot see that from
    // anything else in the description.
    const data = facts(await buildDeliveryResource(job({ courierOxyUserId: undefined })));
    expect(data.courierAssigned).toBe(false);
  });

  it('survives a shipment that no longer exists', async () => {
    shipmentFindById.mockReturnValue(query(null));
    const data = facts(await buildDeliveryResource(job()));
    expect(data.itemDescription).toBeUndefined();
    expect(data.photoCount).toBe(0);
  });
});

describe('buildDeliveryContext', () => {
  it('attaches the delivery as context, not as evidence', async () => {
    const context = await buildDeliveryContext(VALID_ID);
    // Calling it evidence would tell a jury Moovo believes it substantiates the
    // claim, which Moovo has no basis to assert.
    expect(context?.role).toBe('context');
  });

  it('returns null when no delivery was named', async () => {
    expect(await buildDeliveryContext(undefined)).toBeNull();
    expect(jobFindById).not.toHaveBeenCalled();
  });

  it('returns null for a malformed id without querying Mongo', async () => {
    expect(await buildDeliveryContext('not-an-object-id')).toBeNull();
    expect(jobFindById).not.toHaveBeenCalled();
  });

  it('returns null when the job is gone, rather than throwing', async () => {
    jobFindById.mockReturnValue(query(null));
    // A job deleted between the report and its delivery is ordinary; the caller
    // sends the profile alone.
    expect(await buildDeliveryContext(VALID_ID)).toBeNull();
  });
});

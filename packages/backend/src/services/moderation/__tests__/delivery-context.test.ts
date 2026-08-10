/**
 * The whole delivery description, checked for leaks.
 *
 * `redaction.test.ts` proves the endpoint reducer is correct in isolation. This
 * proves the thing that is actually SENT carries none of the PII — a different
 * claim, because `deliveryFacts` assembles its own object and could reintroduce
 * any field it likes without touching `redactEndpoint` at all.
 *
 * ## Where the delivery-code assertions went, and why they are stronger there
 *
 * The verification codes are the only values here that are not merely private
 * but a CREDENTIAL: the dropoff code is what proves to a courier that the person
 * accepting a parcel is the intended recipient, and a juror who learned one
 * could collect somebody else's delivery. The Mongo original seeded them onto a
 * mock document and asserted they could not travel.
 *
 * They cannot be seeded here any more: `JobModerationFacts` has no member for a
 * code, a contact name, a phone number or a street, because
 * `findJobModerationFacts` does not select those columns. Seeding them would
 * mean casting past the type, and the resulting assertion would prove only that
 * a hand-written fixture did not leak.
 *
 * So the leak proof moved to `db/transport/__tests__/job-dispatch.realdb.test.ts`,
 * where a REAL job row genuinely holding all of them is read through the real
 * projection and the real builder. That version cannot be vacuous: the secrets
 * are in the database when the assertion runs.
 *
 * What stays here is the part that is pure and is where a leak is actually
 * introduced — the EXACT key set, which fails on a field added as well as one
 * removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findJobModerationFacts = vi.fn();
const shipmentFindById = vi.fn();

vi.mock('../../../db/transport/jobRepository.js', () => ({
  findJobModerationFacts: (...args: unknown[]) => findJobModerationFacts(...args),
}));
// `shipments` is Postgres, and the seam is the PROJECTION the repository exposes
// rather than a model plus a `.select()` string. The fixture below is narrower
// as a result, and that narrowing is the point: the contact names, phone
// numbers, street addresses and photo file ids are no longer values this module
// declines to pass on — they are values it never loads.
vi.mock('../../../db/transport/shipmentRepository.js', () => ({
  findShipmentModerationFacts: (...args: unknown[]) => shipmentFindById(...args),
}));

import {
  buildDeliveryContext,
  buildDeliveryResource,
  DELIVERY_FACT_KEYS,
} from '../subjects/delivery-context.js';
import type { JobModerationFacts } from '../../../db/transport/jobRepository.js';
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

const VALID_ID = '019836f2-0000-7000-8000-00000000ab01';

function job(overrides: Partial<JobModerationFacts> = {}): JobModerationFacts {
  return {
    id: VALID_ID,
    shipmentId: VALID_ID,
    senderOxyUserId: 'sender-1',
    courierOxyUserId: 'courier-1',
    type: 'package',
    fulfillmentType: 'moovo_courier',
    status: 'delivered',
    pickupCity: 'Barcelona',
    pickupRegion: 'Catalunya',
    pickupCountry: 'ES',
    pickupNotes: 'Collect from reception',
    dropoffCity: 'Girona',
    dropoffCountry: 'ES',
    dropoffNotes: 'Leave with the neighbour',
    parcelSizeClass: 'medium',
    parcelWeightKg: 3.5,
    parcelPieces: 1,
    parcelFragile: true,
    proofNote: 'Handed over at the door',
    createdAt: new Date('2026-07-01T10:00:00Z'),
    ...overrides,
  };
}

function shipment(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    itemDescription: 'A sealed cardboard box, contents unknown',
    // A COUNT, computed in SQL. The file ids themselves never reach this process.
    photoCount: 2,
    type: 'package' as const,
    distanceM: 12_400,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findJobModerationFacts.mockResolvedValue(job());
  shipmentFindById.mockResolvedValue(shipment());
});

describe('the exact key set a delivery may carry', () => {
  /**
   * The assertion that matters most in this file.
   *
   * An exact set comparison, not a list of `not.toHaveProperty` calls. Those only
   * fail when a field they already name goes missing — they are silent about a
   * field ADDED, which is the direction every real leak arrives from: somebody
   * passes an object through, or spreads a row, and a `contactPhone` rides along.
   * A test naming the forbidden fields cannot catch the one nobody has thought of
   * yet. This one catches all of them, including fields that do not exist on the
   * projection today.
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
    // job row being posted through this field. Assert it directly.
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

  it('reduces the distance to whole kilometres', async () => {
    // Two precise points identify two homes; one distance identifies nothing,
    // because a distance is translation-invariant.
    expect(facts(await buildDeliveryResource(job())).distanceKm).toBe(12);
  });

  it('declares photo evidence exists without attaching it', async () => {
    const data = facts(await buildDeliveryResource(job()));
    // A jury that can see material exists which it was not given can answer
    // `insufficient_context` for the right reason rather than by accident.
    expect(data.photoCount).toBe(2);
  });

  it('reports courierAssigned false when no courier ever accepted', async () => {
    // A complaint about a courier on a job no courier was assigned to is a
    // different — and usually mistaken — claim, and a jury cannot see that from
    // anything else in the description.
    const data = facts(await buildDeliveryResource(job({ courierOxyUserId: undefined })));
    expect(data.courierAssigned).toBe(false);
  });

  it('survives a shipment that no longer exists', async () => {
    shipmentFindById.mockResolvedValue(null);
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
    expect(findJobModerationFacts).not.toHaveBeenCalled();
  });

  it('returns null for a malformed id without querying the database', async () => {
    expect(await buildDeliveryContext('not-an-entity-id')).toBeNull();
    expect(findJobModerationFacts).not.toHaveBeenCalled();
  });

  it('returns null when the job is gone, rather than throwing', async () => {
    findJobModerationFacts.mockResolvedValue(null);
    // A job deleted between the report and its delivery is ordinary; the caller
    // sends the profile alone.
    expect(await buildDeliveryContext(VALID_ID)).toBeNull();
  });
});

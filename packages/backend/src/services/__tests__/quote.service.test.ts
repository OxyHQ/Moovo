/**
 * Unit tests for `quote.service.quoteShipment`.
 *
 * The shipment/quote/provider repositories and the provider registry are mocked,
 * so this suite tests the quote CONTRACT and nothing about SQL: the internal
 * Moovo-courier quote is ALWAYS present; enabled providers contribute external
 * quotes; ONE failing/throwing provider is ISOLATED (the others still produce
 * quotes, and the failure is not propagated); the distance is persisted and the
 * shipment is flipped quoting → quoted.
 *
 * Three shape changes came with the port, and they are the same three every
 * retargeted suite in this repo sees:
 *
 *  - a repository function RESOLVES its rows, where the Mongoose call returned a
 *    chainable needing `.lean()`;
 *  - an id is `id`, never `_id`;
 *  - the seam is a named function, so a test asserts the ARGUMENTS a service
 *    passed rather than the shape of an update document. `{$set: {status:
 *    'quoted'}}` is not something the service composes any more — the intent has
 *    a name, `markShipmentQuoted`, and the CAS predicate that makes it safe now
 *    lives in the repository, where a realdb test can reach it.
 *
 * The transaction is mocked as "run the callback" — its ATOMICITY is a property
 * of a real server and is asserted in `quote-shipment.realdb.test.ts`, not here.
 * A mocked transaction that resolves cannot roll anything back, so a test using
 * one to claim atomicity would pass against code that had none.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderQuote } from '@moovo/shared-types';

const updateShipmentDistance = vi.fn();
const markShipmentQuoted = vi.fn();
const insertQuotes = vi.fn();
const providerFind = vi.fn();
const getAdapter = vi.fn();

/** A transaction handle that simply runs its callback — see the module header. */
const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ tx: true }));
vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({ transaction: (cb: (tx: unknown) => Promise<unknown>) => transaction(cb) }),
}));

vi.mock('../../db/transport/shipmentRepository.js', () => ({
  updateShipmentDistance: (...args: unknown[]) => updateShipmentDistance(...args),
  markShipmentQuoted: (...args: unknown[]) => markShipmentQuoted(...args),
}));

vi.mock('../../db/transport/quoteRepository.js', () => ({
  insertQuotes: (...args: unknown[]) => insertQuotes(...args),
  listActiveQuotesForShipment: vi.fn(),
}));

vi.mock('../../db/transport/providerRepository.js', () => ({
  listEnabledProvidersForType: (...args: unknown[]) => providerFind(...args),
}));

vi.mock('../providers/provider-registry.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapter(...args),
}));

import { quoteShipment } from '../quote.service.js';
import type { ShipmentRecord } from '../../db/transport/shipmentShape.js';

/** A FAIR price breakdown helper. */
function breakdown(total: number): ProviderQuote['priceBreakdown'] {
  return {
    base: { fairMinor: 100, originalCurrency: 'FAIR' },
    distance: { fairMinor: total - 100, originalCurrency: 'FAIR' },
    size: { fairMinor: 0, originalCurrency: 'FAIR' },
    total: { fairMinor: total, originalCurrency: 'FAIR' },
  };
}

/** A shipment record with two endpoints ~1.5km apart. */
function mockShipment(): ShipmentRecord {
  return {
    id: 'shipment-1',
    senderOxyUserId: 'sender-1',
    type: 'package',
    status: 'quoting',
    pickup: {
      location: { type: 'Point', coordinates: [0, 0] },
      address: { line1: 'a', city: 'c', postalCode: 'p', country: 'ES' },
      contactName: 'A',
      contactPhone: '1',
    },
    dropoff: {
      location: { type: 'Point', coordinates: [0.01, 0.01] },
      address: { line1: 'b', city: 'c', postalCode: 'p', country: 'ES' },
      contactName: 'B',
      contactPhone: '2',
    },
    parcel: { weightKg: 1, sizeClass: 'small', pieces: 1 },
    itemDescription: 'a box',
    photos: [],
    scheduling: { kind: 'now' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** The quotes handed to `insertQuotes` by the call under test. */
function writtenQuotes(): Array<{ source: string; providerId?: string }> {
  return insertQuotes.mock.calls[0]?.[0] as Array<{ source: string; providerId?: string }>;
}

beforeEach(() => {
  updateShipmentDistance.mockReset().mockResolvedValue(undefined);
  markShipmentQuoted.mockReset().mockResolvedValue(undefined);
  insertQuotes
    .mockReset()
    .mockImplementation((docs: Record<string, unknown>[]) =>
      Promise.resolve(docs.map((d, i) => ({ ...d, id: `quote-${i}` }))),
    );
  transaction.mockReset().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  );
  providerFind.mockReset();
  getAdapter.mockReset();
});

describe('quote.service.quoteShipment', () => {
  it('always writes the internal moovo_courier quote (no providers enabled)', async () => {
    providerFind.mockResolvedValue([]);

    await quoteShipment(mockShipment());

    expect(insertQuotes).toHaveBeenCalledTimes(1);
    const docs = writtenQuotes();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.source).toBe('moovo_courier');
  });

  it('contributes one external quote per enabled provider adapter', async () => {
    providerFind.mockResolvedValue([
      { id: 'prov-dhl', key: 'dhl-mock' },
      { id: 'prov-fedex', key: 'fedex-mock' },
    ]);
    getAdapter.mockImplementation((key: string) => ({
      key,
      quote: async (): Promise<ProviderQuote[]> => [
        { providerKey: key, priceBreakdown: breakdown(900), etaPickupMin: 20, etaDeliveryMin: 40 },
      ],
    }));

    await quoteShipment(mockShipment());

    const docs = writtenQuotes();
    expect(docs).toHaveLength(3); // 1 internal + 2 external
    expect(docs.filter((d) => d.source === 'moovo_courier')).toHaveLength(1);
    expect(docs.filter((d) => d.source === 'external_provider')).toHaveLength(2);
  });

  it('isolates ONE failing provider — the others still produce quotes', async () => {
    providerFind.mockResolvedValue([
      { id: 'prov-bad', key: 'bad-mock' },
      { id: 'prov-good', key: 'good-mock' },
    ]);
    getAdapter.mockImplementation((key: string) => ({
      key,
      quote: async (): Promise<ProviderQuote[]> => {
        if (key === 'bad-mock') {
          throw new Error('provider exploded');
        }
        return [{ providerKey: key, priceBreakdown: breakdown(800) }];
      },
    }));

    // Must NOT reject despite the failing provider.
    await expect(quoteShipment(mockShipment())).resolves.toBeDefined();

    const docs = writtenQuotes();
    // 1 internal + 1 from the good provider (the bad one is isolated/skipped).
    expect(docs).toHaveLength(2);
    expect(docs.filter((d) => d.source === 'external_provider')).toHaveLength(1);
    expect(docs.find((d) => d.source === 'external_provider')?.providerId).toBe('prov-good');
  });

  it('flips the shipment quoting → quoted after the internal quote lands', async () => {
    providerFind.mockResolvedValue([]);

    await quoteShipment(mockShipment());

    expect(markShipmentQuoted).toHaveBeenCalledWith('shipment-1', expect.anything());
  });

  it('persists the computed distance on the shipment', async () => {
    providerFind.mockResolvedValue([]);

    await quoteShipment(mockShipment());

    expect(updateShipmentDistance).toHaveBeenCalledTimes(1);
    const [shipmentId, distanceM] = updateShipmentDistance.mock.calls[0] as [string, number];
    expect(shipmentId).toBe('shipment-1');
    expect(distanceM).toBeGreaterThan(0);
  });

  /**
   * The write half runs inside the transaction and the fan-out does not.
   *
   * Asserted through the ORDER of the mocked calls rather than by inspecting a
   * handle: the distance write and the provider fan-out must both have happened
   * BEFORE the transaction callback opens, because a transaction held across
   * several carriers' network calls pins a pooled connection for as long as the
   * slowest adapter takes. A test that only checked "the quotes were written"
   * would pass equally well with the fan-out inside.
   */
  it('opens the transaction AFTER the provider fan-out, not around it', async () => {
    const order: string[] = [];
    providerFind.mockImplementation(async () => {
      order.push('fan-out');
      return [];
    });
    updateShipmentDistance.mockImplementation(async () => {
      order.push('distance');
    });
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      order.push('transaction');
      return cb({ tx: true });
    });

    await quoteShipment(mockShipment());

    expect(order).toEqual(['distance', 'fan-out', 'transaction']);
  });
});

/**
 * Unit tests for `quote.service.quoteShipment`.
 *
 * `mongodb-memory-server` is not available, so the Shipment/Quote/Provider
 * models and the provider registry are mocked. Tests assert the quote contract:
 * the internal Moovo-courier quote is ALWAYS present; enabled providers
 * contribute external quotes; ONE failing/throwing provider is ISOLATED (the
 * others still produce quotes, and the failure is not propagated); the shipment
 * is flipped quoting → quoted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderQuote } from '@moovo/shared-types';

const shipmentUpdateOne = vi.fn();
const quoteInsertMany = vi.fn();
const providerFind = vi.fn();
const getAdapter = vi.fn();

vi.mock('../../models/shipment.js', () => ({
  Shipment: { updateOne: (...args: unknown[]) => shipmentUpdateOne(...args) },
}));

vi.mock('../../models/quote.js', () => ({
  Quote: { insertMany: (...args: unknown[]) => quoteInsertMany(...args), find: vi.fn() },
}));

vi.mock('../../models/provider.js', () => ({
  Provider: { find: (...args: unknown[]) => providerFind(...args) },
}));

vi.mock('../providers/provider-registry.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapter(...args),
}));

import { quoteShipment } from '../quote.service.js';
import type { IShipment } from '../../models/shipment.js';

/** A FAIR price breakdown helper. */
function breakdown(total: number): ProviderQuote['priceBreakdown'] {
  return {
    base: { fairMinor: 100, originalCurrency: 'FAIR' },
    distance: { fairMinor: total - 100, originalCurrency: 'FAIR' },
    size: { fairMinor: 0, originalCurrency: 'FAIR' },
    total: { fairMinor: total, originalCurrency: 'FAIR' },
  };
}

/** A mock shipment doc with two endpoints ~1km apart. */
function mockShipment(): IShipment {
  return {
    _id: 'shipment-1',
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
  } as unknown as IShipment;
}

beforeEach(() => {
  shipmentUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  // insertMany echoes back lean-ish docs with a `toObject` mirror.
  quoteInsertMany.mockReset().mockImplementation((docs: Record<string, unknown>[]) =>
    Promise.resolve(
      docs.map((d, i) => ({ ...d, _id: `quote-${i}`, toObject: () => ({ ...d, _id: `quote-${i}` }) })),
    ),
  );
  providerFind.mockReset();
  getAdapter.mockReset();
});

describe('quote.service.quoteShipment', () => {
  it('always writes the internal moovo_courier quote (no providers enabled)', async () => {
    providerFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    await quoteShipment(mockShipment());

    expect(quoteInsertMany).toHaveBeenCalledTimes(1);
    const docs = quoteInsertMany.mock.calls[0][0] as { source: string }[];
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe('moovo_courier');
  });

  it('contributes one external quote per enabled provider adapter', async () => {
    providerFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { _id: 'prov-dhl', key: 'dhl-mock' },
          { _id: 'prov-fedex', key: 'fedex-mock' },
        ]),
    });
    getAdapter.mockImplementation((key: string) => ({
      key,
      quote: async (): Promise<ProviderQuote[]> => [
        { providerKey: key, priceBreakdown: breakdown(900), etaPickupMin: 20, etaDeliveryMin: 40 },
      ],
    }));

    await quoteShipment(mockShipment());

    const docs = quoteInsertMany.mock.calls[0][0] as { source: string; providerId?: string }[];
    expect(docs).toHaveLength(3); // 1 internal + 2 external
    expect(docs.filter((d) => d.source === 'moovo_courier')).toHaveLength(1);
    expect(docs.filter((d) => d.source === 'external_provider')).toHaveLength(2);
  });

  it('isolates ONE failing provider — the others still produce quotes', async () => {
    providerFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { _id: 'prov-bad', key: 'bad-mock' },
          { _id: 'prov-good', key: 'good-mock' },
        ]),
    });
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

    const docs = quoteInsertMany.mock.calls[0][0] as { source: string; providerId?: string }[];
    // 1 internal + 1 from the good provider (the bad one is isolated/skipped).
    expect(docs).toHaveLength(2);
    expect(docs.filter((d) => d.source === 'external_provider')).toHaveLength(1);
    expect(docs.find((d) => d.source === 'external_provider')?.providerId).toBe('prov-good');
  });

  it('flips the shipment quoting → quoted after the internal quote lands', async () => {
    providerFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    await quoteShipment(mockShipment());

    // First updateOne persists distance; a later updateOne flips status to quoted.
    const statusFlip = shipmentUpdateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } })?.$set?.status === 'quoted',
    );
    expect(statusFlip).toBeDefined();
  });

  it('persists the computed distance on the shipment', async () => {
    providerFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    await quoteShipment(mockShipment());

    const distanceUpdate = shipmentUpdateOne.mock.calls.find(
      (call) => typeof (call[1] as { $set?: { distanceM?: number } })?.$set?.distanceM === 'number',
    );
    expect(distanceUpdate).toBeDefined();
  });
});

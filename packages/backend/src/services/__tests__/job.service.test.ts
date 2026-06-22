/**
 * Unit tests for `job.service` (transitions + idempotent booking).
 *
 * `mongodb-memory-server` is not available, so the Job/Shipment/Quote/Provider
 * models, the counter, and the provider registry are mocked. Tests assert: every
 * LEGAL transition succeeds and calls the CAS with a current-status guard; every
 * ILLEGAL transition throws CONFLICT before the CAS; and an idempotent booking
 * converges on the prior job on a Mongo 11000 duplicate-key error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const jobFindOneAndUpdate = vi.fn();
const jobFindOne = vi.fn();
const jobFindById = vi.fn();
const jobCreate = vi.fn();
const shipmentFindById = vi.fn();
const shipmentUpdateOne = vi.fn();
const quoteFindById = vi.fn();
const quoteUpdateOne = vi.fn();
const providerFindById = vi.fn();
const nextJobNumber = vi.fn();
const getAdapter = vi.fn();

vi.mock('../../models/job.js', () => ({
  Job: {
    findOneAndUpdate: (...args: unknown[]) => jobFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => jobFindOne(...args),
    findById: (...args: unknown[]) => jobFindById(...args),
    create: (...args: unknown[]) => jobCreate(...args),
    findByIdAndUpdate: vi.fn(),
    countDocuments: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock('../../models/shipment.js', () => ({
  Shipment: {
    findById: (...args: unknown[]) => shipmentFindById(...args),
    updateOne: (...args: unknown[]) => shipmentUpdateOne(...args),
  },
}));

vi.mock('../../models/quote.js', () => ({
  Quote: {
    findById: (...args: unknown[]) => quoteFindById(...args),
    updateOne: (...args: unknown[]) => quoteUpdateOne(...args),
  },
}));

vi.mock('../../models/provider.js', () => ({
  Provider: { findById: (...args: unknown[]) => providerFindById(...args) },
}));

vi.mock('../../models/counter.js', () => ({
  nextJobNumber: (...args: unknown[]) => nextJobNumber(...args),
}));

vi.mock('../providers/provider-registry.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapter(...args),
}));

import { transition, bookShipment } from '../job.service.js';
import type { IJob } from '../../models/job.js';
import type { HydratedDocument } from 'mongoose';
import type { JobStatus } from '@moovo/shared-types';
import { isMoovoError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** A mock job doc with a mutable status + history. */
function mockJob(status: JobStatus): HydratedDocument<IJob> {
  const doc = {
    _id: 'job-1',
    status,
    fulfillmentType: 'moovo_courier' as const,
    courierOxyUserId: 'courier-1',
    statusHistory: [] as IJob['statusHistory'],
  };
  return doc as unknown as HydratedDocument<IJob>;
}

/** A FAIR breakdown for booking tests. */
function breakdown() {
  return {
    base: { fairMinor: 100, originalCurrency: 'FAIR' as const },
    distance: { fairMinor: 200, originalCurrency: 'FAIR' as const },
    size: { fairMinor: 0, originalCurrency: 'FAIR' as const },
    total: { fairMinor: 300, originalCurrency: 'FAIR' as const },
  };
}

beforeEach(() => {
  jobFindOneAndUpdate
    .mockReset()
    .mockImplementation((filter: { _id: unknown }, update: { $set: { status: JobStatus } }) =>
      Promise.resolve({ _id: filter._id, status: update.$set.status }),
    );
  jobFindOne.mockReset();
  jobFindById.mockReset();
  jobCreate.mockReset();
  shipmentFindById.mockReset();
  shipmentUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  quoteFindById.mockReset();
  quoteUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  providerFindById.mockReset();
  nextJobNumber.mockReset().mockResolvedValue('MOV-000001');
  getAdapter.mockReset();
});

describe('job.service.transition — legal transitions', () => {
  const legal: { from: JobStatus; to: JobStatus }[] = [
    { from: 'requested', to: 'offered' },
    { from: 'requested', to: 'accepted' },
    { from: 'requested', to: 'cancelled' },
    { from: 'offered', to: 'accepted' },
    { from: 'offered', to: 'cancelled' },
    { from: 'offered', to: 'requested' },
    { from: 'accepted', to: 'picked_up' },
    { from: 'accepted', to: 'cancelled' },
    { from: 'picked_up', to: 'in_transit' },
    { from: 'picked_up', to: 'cancelled' },
    { from: 'in_transit', to: 'delivered' },
    { from: 'in_transit', to: 'cancelled' },
  ];

  for (const { from, to } of legal) {
    it(`allows ${from} → ${to} and CASes with a current-status guard`, async () => {
      const doc = mockJob(from);
      await transition(doc, to, { actorOxyUserId: 'actor-1' });
      expect(doc.status).toBe(to);
      expect(jobFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter] = jobFindOneAndUpdate.mock.calls[0];
      expect((filter as { status: JobStatus }).status).toBe(from);
    });
  }
});

describe('job.service.transition — illegal transitions', () => {
  const illegal: { from: JobStatus; to: JobStatus }[] = [
    { from: 'requested', to: 'picked_up' },
    { from: 'requested', to: 'delivered' },
    { from: 'offered', to: 'picked_up' },
    { from: 'offered', to: 'delivered' },
    { from: 'accepted', to: 'in_transit' },
    { from: 'accepted', to: 'offered' },
    { from: 'delivered', to: 'accepted' },
    { from: 'cancelled', to: 'accepted' },
    { from: 'in_transit', to: 'accepted' },
  ];

  for (const { from, to } of illegal) {
    it(`rejects ${from} → ${to} with CONFLICT (before the CAS)`, async () => {
      const doc = mockJob(from);
      await expect(transition(doc, to, {})).rejects.toSatisfy(
        (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
      );
      expect(jobFindOneAndUpdate).not.toHaveBeenCalled();
    });
  }

  it('a lost CAS (concurrent transition) throws CONFLICT', async () => {
    jobFindOneAndUpdate.mockReset().mockResolvedValue(null);
    const doc = mockJob('requested');
    await expect(transition(doc, 'accepted', {})).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
  });
});

describe('job.service.bookShipment — idempotent booking', () => {
  const shipment = {
    _id: 'shipment-1',
    senderOxyUserId: 'sender-1',
    status: 'quoted',
    type: 'package',
    pickup: {},
    dropoff: {},
    parcel: { sizeClass: 'small' },
  };
  const quote = {
    _id: 'quote-1',
    shipmentId: 'shipment-1',
    source: 'moovo_courier',
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    priceBreakdown: breakdown(),
  };

  beforeEach(() => {
    shipmentFindById.mockReturnValue({ lean: () => Promise.resolve(shipment) });
    quoteFindById.mockReturnValue({ lean: () => Promise.resolve(quote) });
  });

  it('creates exactly one job and marks the quote selected + shipment booked', async () => {
    jobCreate.mockResolvedValue({ toObject: () => ({ _id: 'job-1', status: 'requested' }) });

    const job = await bookShipment('sender-1', 'shipment-1', 'quote-1', 'idem-1');

    expect(job).toMatchObject({ _id: 'job-1' });
    expect(jobCreate).toHaveBeenCalledTimes(1);
    expect(quoteUpdateOne).toHaveBeenCalledWith({ _id: 'quote-1' }, { $set: { status: 'selected' } });
    const shipmentSet = shipmentUpdateOne.mock.calls.find(
      (call) => (call[1] as { $set?: { status?: string } })?.$set?.status === 'booked',
    );
    expect(shipmentSet).toBeDefined();
  });

  it('converges on the prior job when create hits a 11000 duplicate key', async () => {
    jobCreate.mockRejectedValue({ code: 11000 });
    jobFindOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'job-prior', status: 'requested' }) });

    const job = await bookShipment('sender-1', 'shipment-1', 'quote-1', 'idem-1');

    expect(job).toMatchObject({ _id: 'job-prior' });
    // No quote/shipment mutation on the converge path.
    expect(quoteUpdateOne).not.toHaveBeenCalled();
  });
});

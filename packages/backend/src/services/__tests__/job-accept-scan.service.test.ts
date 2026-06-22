/**
 * Unit tests for `job.service` Phase-3 behaviors: offer-gated accept (atomic CAS)
 * and QR pickup/dropoff scan.
 *
 * Models (Job, JobOffer, CourierProfile), the socket, the job-events service, and
 * the notification service are mocked. Tests assert: a winning accept marks the
 * offer accepted + siblings superseded + emits the losers + flips the courier to
 * on_job; a lost CAS throws CONFLICT; accepting without a live offer is
 * forbidden; a valid pickup/dropoff scan transitions (+ records POD on dropoff);
 * a wrong code is rejected WITHOUT echoing the expected code; and a wrong status
 * is a CONFLICT.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const jobFindOne = vi.fn();
const jobFindOneAndUpdate = vi.fn();
const offerFindOne = vi.fn();
const offerFind = vi.fn();
const offerUpdateOne = vi.fn();
const offerUpdateMany = vi.fn();
const offerAggregate = vi.fn();
const profileUpdateOne = vi.fn();
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
const emitJobStatus = vi.fn();
const verifyCode = vi.fn();

vi.mock('../../models/job.js', () => ({
  Job: {
    findOne: (...args: unknown[]) => jobFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => jobFindOneAndUpdate(...args),
    findById: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    countDocuments: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock('../../models/job-offer.js', () => ({
  JobOffer: {
    findOne: (...args: unknown[]) => offerFindOne(...args),
    find: (...args: unknown[]) => offerFind(...args),
    updateOne: (...args: unknown[]) => offerUpdateOne(...args),
    updateMany: (...args: unknown[]) => offerUpdateMany(...args),
    aggregate: (...args: unknown[]) => offerAggregate(...args),
  },
  NON_TERMINAL_OFFER_STATUSES: ['offered'],
}));

vi.mock('../../models/courier-profile.js', () => ({
  CourierProfile: { updateOne: (...args: unknown[]) => profileUpdateOne(...args) },
}));

vi.mock('../../models/shipment.js', () => ({ Shipment: { findById: vi.fn(), updateOne: vi.fn() } }));
vi.mock('../../models/quote.js', () => ({ Quote: { findById: vi.fn(), updateOne: vi.fn() } }));
vi.mock('../../models/provider.js', () => ({ Provider: { findById: vi.fn() } }));
vi.mock('../../models/counter.js', () => ({ nextJobNumber: vi.fn() }));
vi.mock('../providers/provider-registry.js', () => ({ getAdapter: vi.fn() }));

vi.mock('../job-events.service.js', () => ({
  emitJobStatus: (...args: unknown[]) => emitJobStatus(...args),
  emitJobLocation: vi.fn(),
}));

vi.mock('../../socket.js', () => ({ getIO: () => ({ to }) }));

vi.mock('../../utils/job-codes.js', () => ({
  verifyCode: (...args: unknown[]) => verifyCode(...args),
  generateCode: vi.fn(() => 'code'),
  hashCode: vi.fn((c: string) => `hash:${c}`),
}));

import { accept, scanJob } from '../job.service.js';
import { isMoovoError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

beforeEach(() => {
  vi.clearAllMocks();
  offerUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  offerUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  offerAggregate.mockResolvedValue([]);
  profileUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  emitJobStatus.mockResolvedValue(undefined);
});

describe('accept — offer-gated CAS', () => {
  function setupWin() {
    jobFindOne.mockResolvedValue({ _id: 'job-1', fulfillmentType: 'moovo_courier', status: 'offered' });
    offerFindOne.mockResolvedValue({ _id: 'offer-c1', courierOxyUserId: 'c1', status: 'offered' });
    jobFindOneAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'job-1', status: 'accepted', senderOxyUserId: 's1', courierOxyUserId: 'c1', jobNumber: 'MOV-1' }),
    });
    offerFind.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([{ courierOxyUserId: 'c2' }, { courierOxyUserId: 'c3' }]) }),
    });
  }

  it('a winning accept: offer accepted, siblings superseded, losers emitted, courier on_job', async () => {
    setupWin();

    const job = await accept('c1', 'job-1');

    expect(job).toMatchObject({ _id: 'job-1', status: 'accepted' });
    // CAS guarded on status: 'offered'.
    expect(jobFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'job-1', status: 'offered' });
    // Winner's own offer accepted.
    expect(offerUpdateOne).toHaveBeenCalledWith({ _id: 'offer-c1' }, { $set: { status: 'accepted' } });
    // Siblings superseded.
    expect(offerUpdateMany).toHaveBeenCalledWith(
      { jobId: 'job-1', status: 'offered', _id: { $ne: 'offer-c1' } },
      { $set: { status: 'superseded' } },
    );
    // Losers emitted job:offer_taken.
    expect(to).toHaveBeenCalledWith('user:c2');
    expect(to).toHaveBeenCalledWith('user:c3');
    expect(emit).toHaveBeenCalledWith('job:offer_taken', { jobId: 'job-1' });
    // Courier flipped to on_job.
    expect(profileUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'c1' },
      { $set: { onlineStatus: 'on_job' } },
    );
    // Sender notified of acceptance.
    expect(emitJobStatus).toHaveBeenCalledWith(expect.objectContaining({ _id: 'job-1' }), 'accepted');
  });

  it('a lost CAS throws CONFLICT and supersedes the late offer', async () => {
    jobFindOne.mockResolvedValue({ _id: 'job-1', fulfillmentType: 'moovo_courier', status: 'offered' });
    offerFindOne.mockResolvedValue({ _id: 'offer-c1', courierOxyUserId: 'c1', status: 'offered' });
    jobFindOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(null) });

    await expect(accept('c1', 'job-1')).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(offerUpdateOne).toHaveBeenCalledWith({ _id: 'offer-c1' }, { $set: { status: 'superseded' } });
  });

  it('accepting WITHOUT a live offer is forbidden', async () => {
    jobFindOne.mockResolvedValue({ _id: 'job-1', fulfillmentType: 'moovo_courier', status: 'offered' });
    offerFindOne.mockResolvedValue(null);

    await expect(accept('c1', 'job-1')).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(jobFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('scanJob — QR pickup/dropoff proof', () => {
  /** A NON-lean mutable job doc supporting transition() + toObject(). */
  function mockScanJob(status: string) {
    const doc = {
      _id: 'job-1',
      fulfillmentType: 'moovo_courier',
      courierOxyUserId: 'c1',
      senderOxyUserId: 's1',
      status,
      pickupCodeHash: 'hash:p',
      dropoffCodeHash: 'hash:d',
      statusHistory: [] as unknown[],
      toObject() {
        return { ...this };
      },
    };
    return doc;
  }

  it('a valid pickup scan transitions accepted → picked_up', async () => {
    const doc = mockScanJob('accepted');
    jobFindOne.mockResolvedValue(doc);
    verifyCode.mockReturnValue(true);
    jobFindOneAndUpdate.mockResolvedValue({ _id: 'job-1', status: 'picked_up' });

    await scanJob('c1', 'job-1', { leg: 'pickup', code: 'p' });

    expect(verifyCode).toHaveBeenCalledWith('p', 'hash:p');
    // transition's CAS guarded on the current status.
    expect(jobFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'job-1', status: 'accepted' });
    expect(emitJobStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'picked_up' }), 'picked_up');
  });

  it('a valid dropoff scan transitions in_transit → delivered and records POD', async () => {
    const doc = mockScanJob('in_transit');
    jobFindOne.mockResolvedValue(doc);
    verifyCode.mockReturnValue(true);
    jobFindOneAndUpdate.mockResolvedValue({ _id: 'job-1', status: 'delivered' });

    await scanJob('c1', 'job-1', { leg: 'dropoff', code: 'd', photoFileId: 'file-1' });

    expect(verifyCode).toHaveBeenCalledWith('d', 'hash:d');
    const update = jobFindOneAndUpdate.mock.calls[0][1] as { $set: { proofOfDelivery?: { note?: string; photoFileId?: string } } };
    expect(update.$set.proofOfDelivery).toMatchObject({ note: 'scanned', photoFileId: 'file-1' });
    expect(emitJobStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered' }), 'delivered');
  });

  it('a wrong code is rejected (VALIDATION_ERROR) without echoing the expected code', async () => {
    const doc = mockScanJob('accepted');
    jobFindOne.mockResolvedValue(doc);
    verifyCode.mockReturnValue(false);

    await expect(scanJob('c1', 'job-1', { leg: 'pickup', code: 'wrong' })).rejects.toSatisfy(
      (err: unknown) =>
        isMoovoError(err) &&
        err.code === ErrorCodes.VALIDATION_ERROR &&
        // The expected code/hash is NEVER echoed in the error message.
        !err.message.includes('hash:p'),
    );
    expect(jobFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a pickup scan in the wrong status is a CONFLICT', async () => {
    const doc = mockScanJob('in_transit');
    jobFindOne.mockResolvedValue(doc);

    await expect(scanJob('c1', 'job-1', { leg: 'pickup', code: 'p' })).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(verifyCode).not.toHaveBeenCalled();
  });
});

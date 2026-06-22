/**
 * Unit tests for the transport dispatch handlers (`handleExpireOffers`).
 *
 * Models (Job, JobOffer), the dispatch service, the job service transition, and
 * the notification service are mocked. Tests assert: stale `offered` offers are
 * flipped to `expired`; a job still awaiting a courier (no live/accepted offer)
 * with `dispatchAttempts < maxWaves` is re-dispatched (next wave); and a job that
 * exhausted its waves is cancelled (`no_courier`) and its sender notified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const jobFind = vi.fn();
const jobFindById = vi.fn();
const offerUpdateMany = vi.fn();
const offerExists = vi.fn();
const dispatchJob = vi.fn();
const transition = vi.fn();
const sendNotification = vi.fn();

vi.mock('../../models/job.js', () => ({
  Job: {
    find: (...args: unknown[]) => jobFind(...args),
    findById: (...args: unknown[]) => jobFindById(...args),
  },
}));

vi.mock('../../models/job-offer.js', () => ({
  JobOffer: {
    updateMany: (...args: unknown[]) => offerUpdateMany(...args),
    exists: (...args: unknown[]) => offerExists(...args),
  },
  NON_TERMINAL_OFFER_STATUSES: ['offered'],
}));

vi.mock('../../services/dispatch.service.js', () => ({
  dispatchJob: (...args: unknown[]) => dispatchJob(...args),
}));

vi.mock('../../services/job.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
}));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

import { handleExpireOffers } from '../dispatch-handlers.js';
import { config } from '../../config/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  offerUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  offerExists.mockResolvedValue(null);
  dispatchJob.mockResolvedValue({ offered: 1, wave: 2 });
  transition.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
});

describe('handleExpireOffers — stale offer sweep', () => {
  it('flips stale offered offers to expired (semantic flip before TTL)', async () => {
    offerUpdateMany.mockResolvedValue({ modifiedCount: 3 });
    jobFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    await handleExpireOffers();

    const expireCall = offerUpdateMany.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'offered',
    );
    expect(expireCall).toBeDefined();
    expect((expireCall?.[1] as { $set: { status: string } }).$set.status).toBe('expired');
  });

  it('does nothing further when no jobs are awaiting a courier', async () => {
    jobFind.mockReturnValue({ lean: () => Promise.resolve([]) });

    await handleExpireOffers();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });
});

describe('handleExpireOffers — re-dispatch vs cancel', () => {
  it('re-dispatches a job under maxWaves with no live/accepted offer (next wave, excludes prior)', async () => {
    jobFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: 'job-1', senderOxyUserId: 's1', dispatchAttempts: 1, status: 'offered' }]),
    });
    // No live offer, no accepted offer.
    offerExists.mockResolvedValue(null);

    await handleExpireOffers();

    expect(dispatchJob).toHaveBeenCalledWith('job-1');
    expect(transition).not.toHaveBeenCalled();
  });

  it('skips a job that still has a live offer', async () => {
    jobFind.mockReturnValue({
      lean: () => Promise.resolve([{ _id: 'job-1', senderOxyUserId: 's1', dispatchAttempts: 1, status: 'offered' }]),
    });
    // First exists() (live offer) returns truthy → skip.
    offerExists.mockResolvedValueOnce({ _id: 'live' });

    await handleExpireOffers();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('cancels (no_courier) + notifies the sender when waves are exhausted', async () => {
    jobFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { _id: 'job-1', jobNumber: 'MOV-1', senderOxyUserId: 's1', dispatchAttempts: config.dispatch.maxWaves, status: 'offered' },
        ]),
    });
    offerExists.mockResolvedValue(null);
    jobFindById.mockResolvedValue({ _id: 'job-1', status: 'offered' });

    await handleExpireOffers();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0][1]).toBe('cancelled');
    expect(transition.mock.calls[0][2]).toMatchObject({ note: 'no_courier' });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 's1', type: 'dispatch_no_courier' }),
    );
  });
});

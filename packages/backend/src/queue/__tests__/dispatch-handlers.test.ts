/**
 * Unit tests for the transport dispatch handlers (`handleExpireOffers`).
 *
 * The repositories, the dispatch service, the job service transition, and the
 * notification service are mocked. Tests assert: stale `offered` offers are
 * flipped to `expired`; a job still awaiting a courier (no live/accepted offer)
 * with `dispatchAttempts < maxWaves` is re-dispatched (next wave); and a job that
 * exhausted its waves is cancelled (`no_courier`) and its sender notified.
 *
 * The flip's COUNT is the interesting half and cannot be settled here: this
 * suite can only prove the handler logs whatever the repository reported.
 * Whether `expireLapsedOffers` reports a real number — rather than the constant
 * zero a `.length` on a RETURNING-less update would give — is pinned against a
 * real server in `db/transport/__tests__/job-dispatch.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listJobsAwaitingCourier = vi.fn();
const findJobById = vi.fn();
const expireLapsedOffers = vi.fn();
const supersedeLiveOffers = vi.fn();
const jobHasOfferInStatus = vi.fn();
const dispatchJob = vi.fn();
const transition = vi.fn();
const sendNotification = vi.fn();

vi.mock('../../db/transport/jobRepository.js', () => ({
  listJobsAwaitingCourier: (...args: unknown[]) => listJobsAwaitingCourier(...args),
  findJobById: (...args: unknown[]) => findJobById(...args),
}));

vi.mock('../../db/transport/jobOfferRepository.js', () => ({
  expireLapsedOffers: (...args: unknown[]) => expireLapsedOffers(...args),
  supersedeLiveOffers: (...args: unknown[]) => supersedeLiveOffers(...args),
  jobHasOfferInStatus: (...args: unknown[]) => jobHasOfferInStatus(...args),
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
  expireLapsedOffers.mockResolvedValue(0);
  supersedeLiveOffers.mockResolvedValue([]);
  jobHasOfferInStatus.mockResolvedValue(false);
  dispatchJob.mockResolvedValue({ offered: 1, wave: 2 });
  transition.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
});

describe('handleExpireOffers — stale offer sweep', () => {
  it('flips stale offers BEFORE looking at any job, with `now` as the deadline', async () => {
    expireLapsedOffers.mockResolvedValue(3);
    listJobsAwaitingCourier.mockResolvedValue([]);

    await handleExpireOffers();

    expect(expireLapsedOffers).toHaveBeenCalledTimes(1);
    expect(expireLapsedOffers.mock.calls[0][0]).toBeInstanceOf(Date);
    // Order is the property: the semantic flip must land before the sweep reads
    // which jobs are still awaiting a courier, or a job whose offers all lapsed
    // this instant is skipped for another whole cycle.
    expect(expireLapsedOffers.mock.invocationCallOrder[0]).toBeLessThan(
      listJobsAwaitingCourier.mock.invocationCallOrder[0],
    );
  });

  it('does nothing further when no jobs are awaiting a courier', async () => {
    listJobsAwaitingCourier.mockResolvedValue([]);

    await handleExpireOffers();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });
});

describe('handleExpireOffers — re-dispatch vs cancel', () => {
  it('re-dispatches a job under maxWaves with no live/accepted offer (next wave, excludes prior)', async () => {
    listJobsAwaitingCourier.mockResolvedValue([
      { id: 'job-1', senderOxyUserId: 's1', dispatchAttempts: 1, status: 'offered' },
    ]);
    // No live offer, no accepted offer.
    jobHasOfferInStatus.mockResolvedValue(false);

    await handleExpireOffers();

    expect(dispatchJob).toHaveBeenCalledWith('job-1');
    expect(transition).not.toHaveBeenCalled();
  });

  it('skips a job that still has a live offer', async () => {
    listJobsAwaitingCourier.mockResolvedValue([
      { id: 'job-1', senderOxyUserId: 's1', dispatchAttempts: 1, status: 'offered' },
    ]);
    // The first check (a live offer) answers true → skip.
    jobHasOfferInStatus.mockResolvedValueOnce(true);

    await handleExpireOffers();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('cancels (no_courier) + notifies the sender when waves are exhausted', async () => {
    listJobsAwaitingCourier.mockResolvedValue([
      {
        id: 'job-1',
        jobNumber: 'MOV-1',
        senderOxyUserId: 's1',
        dispatchAttempts: config.dispatch.maxWaves,
        status: 'offered',
      },
    ]);
    jobHasOfferInStatus.mockResolvedValue(false);
    findJobById.mockResolvedValue({ id: 'job-1', status: 'offered' });

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

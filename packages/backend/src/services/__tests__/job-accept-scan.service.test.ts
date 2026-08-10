/**
 * Offer-gated accept and QR pickup/dropoff scan, at the SERVICE seam.
 *
 * What belongs here is the decision-making around the write: which refusal a
 * caller gets and when, whose offer is superseded, who is notified, and that a
 * wrong code never echoes the expected one. Those are properties of this
 * module's branching, and a mocked repository is the right instrument for them.
 *
 * What does NOT belong here is whether the CAS actually excludes a second
 * accepter — that is a property of the statement running against a real server
 * under real concurrency, and `db/transport/__tests__/job-dispatch.realdb.test.ts`
 * settles it. A mock told to return `null` proves only that the mock was told
 * to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findJobById = vi.fn();
const casJobAccepted = vi.fn();
const casJobStatus = vi.fn();
const insertJobStatusEvent = vi.fn();
const attachHistory = vi.fn();
const findLiveOfferForCourier = vi.fn();
const setOfferStatus = vi.fn();
const supersedeLiveOffers = vi.fn();
const countOfferOutcomesForCourier = vi.fn();
const markCourierOnJob = vi.fn();
const updateCourierAcceptanceRate = vi.fn();
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
const emitJobStatus = vi.fn();
const verifyCode = vi.fn();

vi.mock('../../db/transport/jobRepository.js', () => ({
  findJobById: (...args: unknown[]) => findJobById(...args),
  casJobAccepted: (...args: unknown[]) => casJobAccepted(...args),
  casJobStatus: (...args: unknown[]) => casJobStatus(...args),
  insertJobStatusEvent: (...args: unknown[]) => insertJobStatusEvent(...args),
  attachHistory: (...args: unknown[]) => attachHistory(...args),
  countJobs: vi.fn(),
  findJobByIdempotencyKey: vi.fn(),
  findJobWithHistory: vi.fn(),
  insertJobIfAbsent: vi.fn(),
  insertLocationPing: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock('../../db/transport/jobOfferRepository.js', () => ({
  findLiveOfferForCourier: (...args: unknown[]) => findLiveOfferForCourier(...args),
  setOfferStatus: (...args: unknown[]) => setOfferStatus(...args),
  supersedeLiveOffers: (...args: unknown[]) => supersedeLiveOffers(...args),
  countOfferOutcomesForCourier: (...args: unknown[]) => countOfferOutcomesForCourier(...args),
}));

vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({ transaction: async (cb: (tx: unknown) => unknown) => cb('TX') }),
}));

vi.mock('../../db/fleet/courierProfileRepository.js', () => ({
  markCourierOnJob: (...args: unknown[]) => markCourierOnJob(...args),
  updateCourierAcceptanceRate: (...args: unknown[]) => updateCourierAcceptanceRate(...args),
}));

// Transport reads `job.service` performs on paths this suite does not exercise.
// Stubbed so importing it never opens a database connection.
vi.mock('../../db/transport/shipmentRepository.js', () => ({
  findShipmentById: vi.fn(),
  markShipmentBooked: vi.fn(),
}));
vi.mock('../../db/transport/quoteRepository.js', () => ({
  findQuoteById: vi.fn(),
  markQuoteSelected: vi.fn(),
}));
vi.mock('../../db/transport/providerRepository.js', () => ({ findProviderById: vi.fn() }));
vi.mock('../../db/sequences/numberRepository.js', () => ({ nextJobNumber: vi.fn() }));
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
import type { JobRecord } from '../../db/transport/jobShape.js';
import { isMoovoError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    fulfillmentType: 'moovo_courier',
    senderOxyUserId: 's1',
    status: 'offered',
    ...overrides,
  } as JobRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  casJobStatus.mockImplementation((write: { jobId: string; to: string }) =>
    Promise.resolve({ id: write.jobId, status: write.to }),
  );
  insertJobStatusEvent.mockResolvedValue(undefined);
  // The trails a response carries; irrelevant to every assertion below, so it
  // echoes the record it was handed rather than inventing history.
  attachHistory.mockImplementation((record: JobRecord) =>
    Promise.resolve({ ...record, statusHistory: [], locationPings: [] }),
  );
  supersedeLiveOffers.mockResolvedValue([]);
  countOfferOutcomesForCourier.mockResolvedValue([]);
  markCourierOnJob.mockResolvedValue(undefined);
  emitJobStatus.mockResolvedValue(undefined);
});

describe('accept — offer-gated CAS', () => {
  function setupWin() {
    findJobById.mockResolvedValue(job());
    findLiveOfferForCourier.mockResolvedValue({ id: 'offer-c1', courierOxyUserId: 'c1' });
    casJobAccepted.mockResolvedValue(
      job({ status: 'accepted', courierOxyUserId: 'c1', jobNumber: 'MOV-1' }),
    );
    supersedeLiveOffers.mockResolvedValue(['c2', 'c3']);
  }

  it('a winning accept: offer accepted, siblings superseded, losers emitted, courier on_job', async () => {
    setupWin();

    const accepted = await accept('c1', 'job-1');

    expect(accepted).toMatchObject({ id: 'job-1', status: 'accepted' });
    expect(casJobAccepted).toHaveBeenCalledWith('job-1', 'c1', 'TX');
    // The audit entry rides the SAME transaction handle as the CAS.
    expect(insertJobStatusEvent.mock.calls[0][1]).toBe('TX');
    expect(setOfferStatus).toHaveBeenCalledWith('offer-c1', 'accepted');
    // Siblings superseded, sparing the winner's own offer.
    expect(supersedeLiveOffers).toHaveBeenCalledWith('job-1', 'offer-c1');
    /**
     * The losers are exactly whom the supersede REPORTED, not a list read
     * beforehand: telling a courier their offer was taken when the statement
     * then matched nothing is a message about something that did not happen.
     */
    expect(to).toHaveBeenCalledWith('user:c2');
    expect(to).toHaveBeenCalledWith('user:c3');
    expect(emit).toHaveBeenCalledWith('job:offer_taken', { jobId: 'job-1' });
    expect(markCourierOnJob).toHaveBeenCalledWith('c1');
    expect(emitJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'accepted',
    );
  });

  it('a lost CAS throws CONFLICT, supersedes the late offer and writes no audit entry', async () => {
    findJobById.mockResolvedValue(job());
    findLiveOfferForCourier.mockResolvedValue({ id: 'offer-c1', courierOxyUserId: 'c1' });
    casJobAccepted.mockResolvedValue(null);

    await expect(accept('c1', 'job-1')).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(setOfferStatus).toHaveBeenCalledWith('offer-c1', 'superseded');
    expect(insertJobStatusEvent).not.toHaveBeenCalled();
  });

  it('accepting WITHOUT a live offer is forbidden, before any write', async () => {
    findJobById.mockResolvedValue(job());
    findLiveOfferForCourier.mockResolvedValue(null);

    await expect(accept('c1', 'job-1')).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(casJobAccepted).not.toHaveBeenCalled();
  });

  it('an external-provider job cannot be accepted by a courier', async () => {
    findJobById.mockResolvedValue(job({ fulfillmentType: 'external_provider' }));

    await expect(accept('c1', 'job-1')).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    // Refused before the offer is even looked up: the rail is wrong, not the
    // caller's standing on it.
    expect(findLiveOfferForCourier).not.toHaveBeenCalled();
  });
});

/**
 * The acceptance rate is the ONE arithmetic in this service, and its trap is
 * the driver's, not the maths': postgres.js decodes `int8` as a string, so a
 * repository that respelled `count()` as a raw `count(*)` would make
 * `resolved += outcome.count` a string CONCATENATION.
 *
 * Two terminal groups is the smallest fixture that can tell the two apart — one
 * group divides correctly under either semantics. That the REPOSITORY returns
 * numbers is pinned against a real server; what is pinned here is that the sum
 * is a sum, so this stays honest even if somebody changes the repository.
 */
describe('accept — acceptance rate', () => {
  it('divides accepted by every RESOLVED offer, excluding still-live ones', async () => {
    findJobById.mockResolvedValue(job());
    findLiveOfferForCourier.mockResolvedValue({ id: 'offer-c1', courierOxyUserId: 'c1' });
    casJobAccepted.mockResolvedValue(job({ status: 'accepted', courierOxyUserId: 'c1' }));
    countOfferOutcomesForCourier.mockResolvedValue([
      { status: 'accepted', count: 3 },
      { status: 'expired', count: 1 },
      { status: 'declined', count: 1 },
      // In flight — a courier is not penalised for an offer still open.
      { status: 'offered', count: 7 },
    ]);

    await accept('c1', 'job-1');

    expect(updateCourierAcceptanceRate).toHaveBeenCalledWith('c1', 3 / 5);
  });

  it('writes no rate at all when nothing has resolved yet', async () => {
    findJobById.mockResolvedValue(job());
    findLiveOfferForCourier.mockResolvedValue({ id: 'offer-c1', courierOxyUserId: 'c1' });
    casJobAccepted.mockResolvedValue(job({ status: 'accepted', courierOxyUserId: 'c1' }));
    countOfferOutcomesForCourier.mockResolvedValue([{ status: 'offered', count: 2 }]);

    await accept('c1', 'job-1');

    // Zero resolved offers is not a zero acceptance rate — it is no data, and
    // writing 0 would penalise a courier for having been offered work.
    expect(updateCourierAcceptanceRate).not.toHaveBeenCalled();
  });
});

describe('scanJob — QR pickup/dropoff proof', () => {
  function scannable(status: JobRecord['status']): JobRecord {
    return job({
      status,
      courierOxyUserId: 'c1',
      pickupCodeHash: 'hash:p',
      dropoffCodeHash: 'hash:d',
    });
  }

  it('a valid pickup scan transitions accepted → picked_up', async () => {
    findJobById.mockResolvedValue(scannable('accepted'));
    verifyCode.mockReturnValue(true);

    await scanJob('c1', 'job-1', { leg: 'pickup', code: 'p' });

    expect(verifyCode).toHaveBeenCalledWith('p', 'hash:p');
    expect(casJobStatus.mock.calls[0][0]).toMatchObject({ from: 'accepted', to: 'picked_up' });
    expect(emitJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'picked_up' }),
      'picked_up',
    );
  });

  it('a valid dropoff scan transitions in_transit → delivered and records POD', async () => {
    findJobById.mockResolvedValue(scannable('in_transit'));
    verifyCode.mockReturnValue(true);

    await scanJob('c1', 'job-1', { leg: 'dropoff', code: 'd', photoFileId: 'file-1' });

    expect(verifyCode).toHaveBeenCalledWith('d', 'hash:d');
    const [write] = casJobStatus.mock.calls[0];
    expect((write as { proofOfDelivery: unknown }).proofOfDelivery).toMatchObject({
      note: 'scanned',
      photoFileId: 'file-1',
    });
    expect(emitJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered' }),
      'delivered',
    );
  });

  it('a wrong code is rejected (VALIDATION_ERROR) without echoing the expected code', async () => {
    findJobById.mockResolvedValue(scannable('accepted'));
    verifyCode.mockReturnValue(false);

    await expect(scanJob('c1', 'job-1', { leg: 'pickup', code: 'wrong' })).rejects.toSatisfy(
      (err: unknown) =>
        isMoovoError(err) &&
        err.code === ErrorCodes.VALIDATION_ERROR &&
        // The expected code/hash is NEVER echoed in the error message.
        !err.message.includes('hash:p'),
    );
    expect(casJobStatus).not.toHaveBeenCalled();
  });

  it('a pickup scan in the wrong status is a CONFLICT, before the code is checked', async () => {
    findJobById.mockResolvedValue(scannable('in_transit'));

    await expect(scanJob('c1', 'job-1', { leg: 'pickup', code: 'p' })).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it('a courier who is not the assigned one is forbidden', async () => {
    findJobById.mockResolvedValue(scannable('accepted'));

    await expect(scanJob('someone-else', 'job-1', { leg: 'pickup', code: 'p' })).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(verifyCode).not.toHaveBeenCalled();
  });
});

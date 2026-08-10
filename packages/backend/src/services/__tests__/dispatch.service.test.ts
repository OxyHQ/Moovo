/**
 * Unit tests for `dispatch.service` (candidate selection + offer fan-out).
 *
 * `mongodb-memory-server` is not available, so Job/JobOffer/CourierProfile, the
 * rate + display helpers, geo, the socket, and the notification service are
 * mocked. Tests assert: the candidate query carries the right
 * onlineStatus/lastPingAt/eligibleJobTypes/$nearSphere/limit shape; that N offers
 * are created, the job moves `requested → offered`, and each candidate is emitted
 * a `job:offer`; and that ZERO candidates leaves the job `requested` (no cancel)
 * while still bumping `dispatchAttempts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const jobFindById = vi.fn();
const jobUpdateOne = vi.fn();
const offerFind = vi.fn();
const offerCreate = vi.fn();
const profileFind = vi.fn();
const transition = vi.fn();
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
const getIO = vi.fn(() => ({ to }));
const sendNotification = vi.fn();
const isEligible = vi.fn();

vi.mock('../../models/job.js', () => ({
  Job: {
    findById: (...args: unknown[]) => jobFindById(...args),
    updateOne: (...args: unknown[]) => jobUpdateOne(...args),
  },
}));

vi.mock('../../models/job-offer.js', () => ({
  JobOffer: {
    find: (...args: unknown[]) => offerFind(...args),
    create: (...args: unknown[]) => offerCreate(...args),
  },
  NON_TERMINAL_OFFER_STATUSES: ['offered'],
}));

// `courier_profiles` is Postgres now, so the seam is the repository — and the
// shape change matters here more than usual: the Mongo call took a FILTER
// OBJECT the test could inspect field by field, while the repository takes a
// typed QUERY. The `$nearSphere`/`$maxDistance` pair is no longer expressible
// as a filter to assert against; it is `ST_DWithin` plus `ORDER BY <->` inside
// the repository, and that ORDERING is pinned by `fleet.realdb.test.ts` against
// a real PostGIS server, which is the only place it can be pinned at all.
vi.mock('../../db/fleet/courierProfileRepository.js', () => ({
  findDispatchCandidates: (...args: unknown[]) => profileFind(...args),
}));

vi.mock('../capability.service.js', () => ({
  isEligible: (...args: unknown[]) => isEligible(...args),
}));

vi.mock('../faircoin-rate.service.js', () => ({
  getFairRate: vi.fn().mockResolvedValue({ fiatPerFair: 1, currency: 'EUR' }),
}));

vi.mock('../../utils/fair-display.js', () => ({
  toDisplayPriceBreakdown: vi.fn().mockReturnValue({}),
}));

vi.mock('../../utils/geo.js', () => ({
  distanceMetersBetween: vi.fn().mockReturnValue(1234),
}));

vi.mock('../../socket.js', () => ({ getIO: () => getIO() }));

vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

vi.mock('../job.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
}));

import { dispatchJob } from '../dispatch.service.js';

/** A NON-lean mock job doc (dispatch loads it with `Job.findById` non-lean). */
function mockJob(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'job-1',
    shipmentId: 'shipment-1',
    fulfillmentType: 'moovo_courier',
    status: 'requested',
    type: 'package',
    dispatchAttempts: 0,
    pickupSnapshot: {
      location: { type: 'Point', coordinates: [2.17, 41.38] },
      address: { city: 'Barcelona' },
    },
    dropoffSnapshot: { address: { city: 'Girona' } },
    parcelSnapshot: { sizeClass: 'small', weightKg: 3 },
    totals: { total: { fairMinor: 600, originalCurrency: 'FAIR' } },
    ...overrides,
  };
}

/** A lean courier profile candidate. */
function mockCandidate(oxyUserId: string) {
  return {
    oxyUserId,
    eligibleJobTypes: ['package'],
    maxSizeClass: 'large',
    maxWeightKg: 50,
    // Ordinate COLUMNS, not a nested GeoJSON point.
    longitude: 2.18,
    latitude: 41.39,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  offerFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  offerCreate.mockImplementation((doc: { courierOxyUserId: string }) =>
    Promise.resolve({ _id: `offer-${doc.courierOxyUserId}` }),
  );
  transition.mockResolvedValue(undefined);
  sendNotification.mockResolvedValue(undefined);
  isEligible.mockReturnValue(true);
});

describe('dispatchJob — candidate selection', () => {
  it('queries online, non-stale, type-eligible couriers near the pickup, limited to waveSize', async () => {
    jobFindById.mockResolvedValue(mockJob());
    let capturedQuery: Record<string, unknown> = {};
    profileFind.mockImplementation((query: Record<string, unknown>) => {
      capturedQuery = query;
      return Promise.resolve([mockCandidate('c1')]);
    });

    await dispatchJob('job-1');

    expect(capturedQuery.jobType).toBe('package');
    expect(capturedQuery.stalePingCutoff).toBeInstanceOf(Date);
    expect(capturedQuery.weightKg).toBe(3);
    expect(capturedQuery.limit).toBeGreaterThan(0);
    expect(capturedQuery.pickup).toEqual({ longitude: 2.17, latitude: 41.38 });
    expect(capturedQuery.radiusM).toBeGreaterThan(0);
  });
});

describe('dispatchJob — offer fan-out', () => {
  it('creates one offer per candidate, moves the job offered, and emits each candidate', async () => {
    jobFindById.mockResolvedValue(mockJob());
    profileFind.mockResolvedValue([mockCandidate('c1'), mockCandidate('c2')]);

    const result = await dispatchJob('job-1');

    expect(result.offered).toBe(2);
    expect(result.wave).toBe(1);
    expect(offerCreate).toHaveBeenCalledTimes(2);
    // First wave transitions requested → offered.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0][1]).toBe('offered');
    // Each candidate is pushed a job:offer on their verified room.
    expect(to).toHaveBeenCalledWith('user:c1');
    expect(to).toHaveBeenCalledWith('user:c2');
    expect(emit).toHaveBeenCalledWith('job:offer', expect.objectContaining({ jobId: 'job-1' }));
    // dispatchAttempts bumped to 1.
    expect(jobUpdateOne).toHaveBeenCalledWith({ _id: 'job-1' }, { $set: { dispatchAttempts: 1 } });
  });

  it('does NOT transition on a re-dispatch wave (job already offered)', async () => {
    jobFindById.mockResolvedValue(mockJob({ status: 'offered', dispatchAttempts: 1 }));
    profileFind.mockResolvedValue([mockCandidate('c3')]);

    const result = await dispatchJob('job-1');

    expect(result.wave).toBe(2);
    expect(transition).not.toHaveBeenCalled();
    expect(offerCreate).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchJob — zero candidates', () => {
  it('leaves the job requested (no transition, no cancel) but bumps dispatchAttempts', async () => {
    jobFindById.mockResolvedValue(mockJob());
    profileFind.mockResolvedValue([]);

    const result = await dispatchJob('job-1');

    expect(result.offered).toBe(0);
    expect(result.wave).toBe(1);
    expect(transition).not.toHaveBeenCalled();
    expect(offerCreate).not.toHaveBeenCalled();
    expect(jobUpdateOne).toHaveBeenCalledWith({ _id: 'job-1' }, { $set: { dispatchAttempts: 1 } });
  });

  it('filters out candidates that fail the precise eligibility gate', async () => {
    jobFindById.mockResolvedValue(mockJob());
    profileFind.mockResolvedValue([mockCandidate('c1')]);
    isEligible.mockReturnValue(false);

    const result = await dispatchJob('job-1');

    expect(result.offered).toBe(0);
    expect(offerCreate).not.toHaveBeenCalled();
  });
});

/**
 * The transition GRAPH, in isolation.
 *
 * `JOB_TRANSITIONS` decides which moves are legal before any statement is
 * issued, and that decision is pure — so it is checked here, against mocked
 * repositories, where all twenty-one cases run in milliseconds.
 *
 * What is NOT here, deliberately: everything whose correctness is a property of
 * the SERVER. The CAS predicate under concurrency, the audit entry committing
 * with the status change, and idempotent booking converging on one job all live
 * in `db/transport/__tests__/job-dispatch.realdb.test.ts`. A mocked `update`
 * accepts any statement and reports whatever the mock was told to, so a suite
 * like this one can prove a guard was PASSED to the repository and can never
 * prove it guards anything.
 *
 * The one assertion here that is about the CAS is the negative: an illegal
 * transition must throw before the repository is called at all, and the mock is
 * exactly the right instrument for "this was never invoked".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const casJobStatus = vi.fn();
const insertJobStatusEvent = vi.fn();

vi.mock('../../db/transport/jobRepository.js', () => ({
  casJobStatus: (...args: unknown[]) => casJobStatus(...args),
  insertJobStatusEvent: (...args: unknown[]) => insertJobStatusEvent(...args),
  attachHistory: vi.fn(),
  casJobAccepted: vi.fn(),
  countJobs: vi.fn(),
  findJobById: vi.fn(),
  findJobByIdempotencyKey: vi.fn(),
  findJobWithHistory: vi.fn(),
  insertJobIfAbsent: vi.fn(),
  insertLocationPing: vi.fn(),
  listJobs: vi.fn(),
}));

/**
 * `transaction(cb)` runs its callback with a handle and returns what it returns.
 *
 * That is all this suite needs from a transaction and all a mock can honestly
 * offer: atomicity is not a property a fake can have, which is why the
 * "CAS and audit entry commit together" claim is proved against a real server
 * instead of here.
 */
vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({ transaction: async (cb: (tx: unknown) => unknown) => cb('TX') }),
}));

// Seams `job.service` imports but no case below reaches. Stubbed so importing
// the module never opens a database connection.
vi.mock('../../db/transport/jobOfferRepository.js', () => ({
  countOfferOutcomesForCourier: vi.fn(),
  findLiveOfferForCourier: vi.fn(),
  setOfferStatus: vi.fn(),
  supersedeLiveOffers: vi.fn(),
}));
vi.mock('../../db/transport/shipmentRepository.js', () => ({
  findShipmentById: vi.fn(),
  markShipmentBooked: vi.fn(),
}));
vi.mock('../../db/transport/quoteRepository.js', () => ({
  findQuoteById: vi.fn(),
  markQuoteSelected: vi.fn(),
}));
vi.mock('../../db/transport/providerRepository.js', () => ({ findProviderById: vi.fn() }));
vi.mock('../../db/fleet/courierProfileRepository.js', () => ({
  markCourierOnJob: vi.fn(),
  updateCourierAcceptanceRate: vi.fn(),
}));
vi.mock('../../db/sequences/numberRepository.js', () => ({ nextJobNumber: vi.fn() }));
vi.mock('../providers/provider-registry.js', () => ({ getAdapter: vi.fn() }));

import { transition } from '../job.service.js';
import type { JobRecord } from '../../db/transport/jobShape.js';
import type { JobStatus } from '@moovo/shared-types';
import { isMoovoError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

/** Only the fields `transition` reads. */
function jobAt(status: JobStatus): JobRecord {
  return { id: 'job-1', status } as JobRecord;
}

beforeEach(() => {
  casJobStatus
    .mockReset()
    .mockImplementation((write: { jobId: string; to: JobStatus }) =>
      Promise.resolve({ id: write.jobId, status: write.to }),
    );
  insertJobStatusEvent.mockReset().mockResolvedValue(undefined);
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
      const moved = await transition(jobAt(from), to, { actorOxyUserId: 'actor-1' });

      // The RETURNED record is the persisted one. The source patched an
      // in-memory copy and callers read that; asserting the return value is the
      // difference between "the service says so" and "the write said so".
      expect(moved.status).toBe(to);
      expect(casJobStatus).toHaveBeenCalledTimes(1);
      const [write] = casJobStatus.mock.calls[0];
      expect(write).toMatchObject({ jobId: 'job-1', from, to });
    });

    it(`records ${from} → ${to} in the audit trail, in the CAS's transaction`, async () => {
      await transition(jobAt(from), to, { actorOxyUserId: 'actor-1' });

      expect(insertJobStatusEvent).toHaveBeenCalledTimes(1);
      const [event, handle] = insertJobStatusEvent.mock.calls[0];
      expect(event).toMatchObject({ jobId: 'job-1', status: to, byOxyUserId: 'actor-1' });
      // The same handle the CAS was given, which is what makes them one commit.
      expect(handle).toBe(casJobStatus.mock.calls[0][1]);
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
      await expect(transition(jobAt(from), to, {})).rejects.toSatisfy(
        (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
      );
      expect(casJobStatus).not.toHaveBeenCalled();
      expect(insertJobStatusEvent).not.toHaveBeenCalled();
    });
  }

  it('a lost CAS (concurrent transition) throws CONFLICT and writes no audit entry', async () => {
    casJobStatus.mockReset().mockResolvedValue(null);

    await expect(transition(jobAt('requested'), 'accepted', {})).rejects.toSatisfy(
      (err: unknown) => isMoovoError(err) && err.code === ErrorCodes.CONFLICT,
    );
    // A loser must leave no trace: an entry saying the job was accepted, beside
    // a status that says it was not, is worse than either state on its own.
    expect(insertJobStatusEvent).not.toHaveBeenCalled();
  });

  it('attaches proof of delivery only on the delivered edge', async () => {
    const proof = { at: new Date(), note: 'left with neighbour' };

    await transition(jobAt('in_transit'), 'delivered', { proofOfDelivery: proof });
    expect(casJobStatus.mock.calls[0][0]).toMatchObject({ proofOfDelivery: proof });

    casJobStatus.mockClear();
    await transition(jobAt('accepted'), 'picked_up', { proofOfDelivery: proof });
    expect(casJobStatus.mock.calls[0][0]).not.toHaveProperty('proofOfDelivery');
  });
});

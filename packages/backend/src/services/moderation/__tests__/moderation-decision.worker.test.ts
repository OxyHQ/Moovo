/**
 * Applying a decision, and refusing to apply a stale one.
 *
 * The revision guard is the reason this file exists. A correction and the
 * decision it supersedes are separate webhook events with separate retry
 * schedules, so revision 1 can arrive — or be retried — after revision 2 has
 * already been applied. Without the filter, a retry of the original suspension
 * would overwrite an accepted appeal's `dismissed` with `resolved`, and the
 * report would say the courier was found in violation of something they had been
 * cleared of. Nothing else in the pipeline would notice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findReportByCaseId = vi.fn();
const applyDecisionToReport = vi.fn();
const applyEnforcementPlan = vi.fn();

vi.mock('../../../db/moderation/reportRepository.js', () => ({
  findReportByCaseId: (...args: unknown[]) => findReportByCaseId(...args),
  applyDecisionToReport: (...args: unknown[]) => applyDecisionToReport(...args),
}));

vi.mock('../moderation-enforcement.service.js', () => ({
  applyEnforcementPlan: (...args: unknown[]) => applyEnforcementPlan(...args),
}));

vi.mock('../../../lib/logger.js', () => ({
  log: { moderation: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import {
  applyDecisionOutboxEvent,
  ModerationDecisionRejectedError,
} from '../moderation-decision.worker.js';
import { decision } from './decision-fixtures.js';

function event(payload: Record<string, unknown>) {
  return {
    id: 'moderation:decision.apply:evt_1',
    kind: 'decision.apply' as const,
    payload,
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(),
    createdAt: new Date(),
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    reportedType: 'courier',
    reportedId: 'courier-1',
    crowdSourceCaseId: 'case_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findReportByCaseId.mockResolvedValue(report());
  applyDecisionToReport.mockResolvedValue(true);
  applyEnforcementPlan.mockResolvedValue({ claimed: 1, applied: 0 });
});

describe('applying a decision', () => {
  it('enforces against the target read from the LOCAL report', async () => {
    await applyDecisionOutboxEvent(
      event({ caseId: 'case_1', decision: decision({ outcome: 'violation' }) }),
    );

    // Read from the report rather than the wire: the report was written by Moovo
    // at intake, so it is the only trustworthy source for what a case is about.
    expect(applyEnforcementPlan).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'courier', targetId: 'courier-1' }),
    );
  });

  it('enforces BEFORE writing the report status', async () => {
    const order: string[] = [];
    applyEnforcementPlan.mockImplementation(async () => {
      order.push('enforce');
      return { claimed: 1, applied: 1 };
    });
    applyDecisionToReport.mockImplementation(async () => {
      order.push('status');
      return { modifiedCount: 1 };
    });

    await applyDecisionOutboxEvent(
      event({ caseId: 'case_1', decision: decision({ outcome: 'violation' }) }),
    );

    // A decision whose effect threw must leave the report at its previous status
    // and the outbox event retried — the alternative marks a report closed on a
    // case whose consequence never happened.
    expect(order).toEqual(['enforce', 'status']);
  });

  it('does not write the status when enforcement throws', async () => {
    applyEnforcementPlan.mockRejectedValue(new Error('mongo down'));
    await expect(
      applyDecisionOutboxEvent(
        event({ caseId: 'case_1', decision: decision({ outcome: 'violation' }) }),
      ),
    ).rejects.toThrow('mongo down');
    expect(applyDecisionToReport).not.toHaveBeenCalled();
  });
});

/**
 * The worker's HALF of the revision guard.
 *
 * The guard itself is a WHERE clause in `applyDecisionToReport`, and whether it
 * actually refuses a stale revision is asserted against real rows in
 * `moderation.realdb.test.ts` — in both directions. It cannot be asserted here,
 * because against a mock the only observable is the arguments this worker passed,
 * and a repository that ignored its `revision` parameter entirely would satisfy
 * every assertion in this file.
 *
 * What IS this worker's responsibility is handing over the DECISION's revision
 * rather than, say, the report's or a constant — a mistake the repository cannot
 * catch, because any number it is given looks like a valid revision.
 */
describe('the revision the worker hands to the guard', () => {
  it('passes the incoming decision revision, and the state it derived', async () => {
    await applyDecisionOutboxEvent(
      event({
        caseId: 'case_1',
        decision: decision({ revision: 2, outcome: 'no_violation', supersedesDecisionId: 'dec_1' }),
      }),
    );

    const [reportId, revision, state] = applyDecisionToReport.mock.calls[0] as [
      string,
      number,
      Record<string, unknown>,
    ];
    expect(reportId).toBe('report-1');
    expect(revision).toBe(2);
    expect(state.status).toBe('dismissed');
  });

  it('passes revision 1 for the first decision a report ever receives', async () => {
    await applyDecisionOutboxEvent(
      event({ caseId: 'case_1', decision: decision({ revision: 1 }) }),
    );
    const [, revision] = applyDecisionToReport.mock.calls[0] as [string, number];
    expect(revision).toBe(1);
  });
});

describe('payloads that cannot be applied', () => {
  it('rejects a decision that does not satisfy the published contract', async () => {
    await expect(
      applyDecisionOutboxEvent(
        event({ caseId: 'case_1', decision: { id: 'dec_1', revision: 'not-a-number' } }),
      ),
    ).rejects.toBeInstanceOf(ModerationDecisionRejectedError);
  });

  it('marks a malformed payload non-retryable so it dead-letters', async () => {
    // No number of retries turns a malformed payload into a valid one.
    const error = await applyDecisionOutboxEvent(
      event({ caseId: 'case_1', decision: { nonsense: true } }),
    ).catch((caught: unknown) => caught);
    expect((error as { retryable?: boolean }).retryable).toBe(false);
  });

  it('rejects an event carrying no caseId', async () => {
    await expect(applyDecisionOutboxEvent(event({}))).rejects.toBeInstanceOf(
      ModerationDecisionRejectedError,
    );
  });

  it('completes quietly when no local report matches the case', async () => {
    findReportByCaseId.mockResolvedValue(null);
    // Retrying will never find it, so this must not throw — it would loop until
    // the event dead-lettered for a reason nobody can act on.
    await expect(
      applyDecisionOutboxEvent(event({ caseId: 'case_missing', decision: decision() })),
    ).resolves.toBeUndefined();
    expect(applyEnforcementPlan).not.toHaveBeenCalled();
  });

  it('rejects a decision naming a report whose type is not deliverable', async () => {
    findReportByCaseId.mockResolvedValue({
      lean: async () => report({ reportedType: 'listing' }),
    });
    // Impossible by construction — a local-only report is never delivered, so no
    // case exists to decide. Reaching here means something bypassed the pipeline.
    await expect(
      applyDecisionOutboxEvent(event({ caseId: 'case_1', decision: decision() })),
    ).rejects.toBeInstanceOf(ModerationDecisionRejectedError);
  });
});

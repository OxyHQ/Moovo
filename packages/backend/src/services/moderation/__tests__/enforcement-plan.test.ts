/**
 * What Moovo will do about a decision — as a table, because it is one.
 *
 * `planEnforcement` is pure, so the whole mapping is testable without a database,
 * a clock or a mode. That is what makes `observe` a real audit rather than a
 * comment: the plan is computed identically in every mode and only its execution
 * is gated, so these assertions describe production behaviour exactly.
 */

import { describe, it, expect } from 'vitest';
import type { RecommendedAction } from '@oxyhq/crowdsource-contracts';
import { planEnforcement } from '../enforcement-plan.js';
import { decision } from './decision-fixtures.js';

function actionsFor(
  recommended: RecommendedAction[],
  target: 'courier' | 'customer' | 'delivery',
  outcome: 'violation' | 'no_violation' = 'violation',
): string[] {
  return planEnforcement(
    decision({ outcome, recommendedActions: recommended.map((action) => ({ action })) }),
    target,
  )
    .map((entry) => entry.action)
    .sort();
}

describe('planEnforcement — a reported courier', () => {
  it.each([
    ['remove', 'suspend_courier'],
    ['remove_or_restrict', 'suspend_courier'],
    ['hide', 'suspend_courier'],
    ['suspend_user', 'suspend_courier'],
  ] as const)('maps %s to %s', (recommended, expected) => {
    expect(actionsFor([recommended], 'courier')).toEqual([expected]);
  });

  it.each([
    'label',
    'age_gate',
    'reduce_distribution',
    'freeze_transaction',
    'legal_queue',
    'specialist_queue',
    'escalate',
  ] as const)('records %s as manual_review rather than dropping it', (recommended) => {
    // Moovo holds no lever for any of these. Recording them is what keeps a
    // declined recommendation distinguishable from one that never arrived.
    expect(actionsFor([recommended], 'courier')).toEqual(['manual_review']);
  });

  it('narrows suspend_user to courier privileges, never the Oxy account', () => {
    const [planned] = planEnforcement(
      decision({ outcome: 'violation', recommendedActions: [{ action: 'suspend_user' }] }),
      'courier',
    );
    // Suspending an Oxy account is Oxy's to carry out. Recording the narrower
    // action under its own name is what keeps that difference visible.
    expect(planned?.action).toBe('suspend_courier');
    expect(planned?.recommendedAction).toBe('suspend_user');
  });

  it('lets a suspension absorb a contradictory reinstatement', () => {
    expect(actionsFor(['remove', 'restore'], 'courier')).toEqual(['suspend_courier']);
  });

  it('keeps manual_review alongside a suspension', () => {
    // Dropping it because something else was also done is how a legal_queue
    // recommendation gets lost.
    expect(actionsFor(['remove', 'legal_queue'], 'courier')).toEqual([
      'manual_review',
      'suspend_courier',
    ]);
  });
});

describe('planEnforcement — a customer or a delivery', () => {
  it.each(['customer', 'delivery'] as const)(
    'refuses to suspend anything for a %s',
    (target) => {
      // There is no schema field anywhere that stops a customer booking, and a
      // collected parcel cannot be un-collected.
      expect(actionsFor(['remove', 'suspend_user'], target)).toEqual(['manual_review']);
    },
  );

  it.each(['allow', 'no_action', 'no_global_effect'] as const)(
    'still maps %s to none',
    (recommended) => {
      expect(actionsFor([recommended], 'customer', 'no_violation')).toEqual(['none']);
    },
  );

  it('sends a violation with no recommendation to a human', () => {
    expect(
      planEnforcement(decision({ outcome: 'violation' }), 'delivery').map((e) => e.action),
    ).toEqual(['manual_review']);
  });
});

describe('no_violation always carries a reinstatement for a courier', () => {
  /**
   * The failure this guards is very easy to ship and very hard to see.
   *
   * A correction or a successful appeal is a new revision whose outcome is
   * `no_violation`, and its recommendation is frequently `no_action` — meaning
   * "take no NEW action", not "leave what you already did in place". Mapped
   * straight through, a courier an earlier revision suspended stays suspended
   * forever: the appeal succeeded and nothing ever lets them work again. For a
   * courier that is somebody's income.
   */
  it('adds reinstate_courier even when the recommendation is no_action', () => {
    expect(actionsFor(['no_action'], 'courier', 'no_violation')).toEqual(['reinstate_courier']);
  });

  it('adds reinstate_courier even when the recommendation is allow', () => {
    expect(actionsFor(['allow'], 'courier', 'no_violation')).toEqual(['reinstate_courier']);
  });

  it('plans it with no recommendations at all', () => {
    expect(
      planEnforcement(decision({ outcome: 'no_violation' }), 'courier').map((e) => e.action),
    ).toEqual(['reinstate_courier']);
  });

  it('does not invent one for a customer, who was never suspended', () => {
    expect(
      planEnforcement(decision({ outcome: 'no_violation' }), 'customer').map((e) => e.action),
    ).toEqual(['none']);
  });
});

describe('severity fallback, when a violation recommends nothing', () => {
  function severityPlan(severity: 'low' | 'medium' | 'high' | 'critical'): string[] {
    return planEnforcement(
      decision({
        outcome: 'violation',
        findings: [
          {
            code: 'other.policy_specific',
            resourceIds: ['res_subject'],
            severity,
            scope: 'application_local',
          },
        ],
      }),
      'courier',
    ).map((entry) => entry.action);
  }

  it('suspends on high', () => {
    expect(severityPlan('high')).toEqual(['suspend_courier']);
  });

  it.each(['low', 'medium'] as const)('asks a human on %s', (severity) => {
    expect(severityPlan(severity)).toEqual(['manual_review']);
  });

  it('asks a human on critical rather than acting automatically', () => {
    // A safe response to critical material is a specialist under legal protocol,
    // which an automatic suspension driven by a webhook is not.
    expect(severityPlan('critical')).toEqual(['manual_review']);
  });
});

describe('outcomes that are not verdicts', () => {
  it.each(['insufficient_context', 'inconclusive', 'escalated'] as const)(
    'changes nothing and asks a human on %s',
    (outcome) => {
      // Absence of consensus is neither guilt nor innocence.
      expect(planEnforcement(decision({ outcome }), 'courier').map((e) => e.action)).toEqual([
        'manual_review',
      ]);
    },
  );

  it.each(['content_unavailable', 'duplicate'] as const)('plans none on %s', (outcome) => {
    expect(planEnforcement(decision({ outcome }), 'courier').map((e) => e.action)).toEqual([
      'none',
    ]);
  });
});

describe('the plan is never empty', () => {
  it('produces an explicit none rather than no rows', () => {
    // A row saying "we decided to do nothing, and why" is evidence; an absent row
    // is a question.
    const planned = planEnforcement(decision({ outcome: 'duplicate' }), 'courier');
    expect(planned).toHaveLength(1);
    expect(planned[0]?.reason).toBeTruthy();
  });

  it('gives every planned action a reason an operator can read', () => {
    for (const target of ['courier', 'customer', 'delivery'] as const) {
      for (const planned of planEnforcement(decision({ outcome: 'violation' }), target)) {
        expect(planned.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

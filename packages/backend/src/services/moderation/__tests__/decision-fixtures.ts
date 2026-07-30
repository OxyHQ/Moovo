/**
 * Valid CrowdSource decisions and webhook envelopes, for tests.
 *
 * Built to satisfy the PUBLISHED schemas rather than hand-waved: `DecisionSchema`
 * cross-validates `jury.agreement === winningVotes / decisiveVotes`, refuses a
 * `violation` with no findings, and requires a `supersedesDecisionId` on every
 * revision after the first. A fixture that skipped any of those would let a test
 * pass against a payload the real receiver would reject — which is the failure
 * mode a fixture is supposed to prevent, not create.
 */

import type { Decision } from '@oxyhq/crowdsource-contracts';

/** A jury whose arithmetic satisfies the contract's own cross-check. */
function jury(): Decision['jury'] {
  return {
    size: 5,
    decisiveVotes: 4,
    winningVotes: 3,
    agreement: 3 / 4,
    specialistPresent: false,
  };
}

function policyVersions(): Decision['policyVersions'] {
  return { taxonomy: '2026.07', application: '2026.07', oxyConduct: '2026.07' };
}

export interface DecisionOverrides {
  readonly id?: string;
  readonly caseId?: string;
  readonly revision?: number;
  readonly status?: Decision['status'];
  readonly outcome?: Decision['outcome'];
  readonly findings?: Decision['findings'];
  readonly recommendedActions?: Decision['recommendedActions'];
  readonly supersedesDecisionId?: string;
}

export function decision(overrides: DecisionOverrides = {}): Decision {
  const revision = overrides.revision ?? 1;
  const outcome = overrides.outcome ?? 'no_violation';
  /**
   * A `violation` needs at least one finding or the contract refuses it, so the
   * default findings follow the outcome rather than being empty everywhere.
   */
  const findings =
    overrides.findings ??
    (outcome === 'violation'
      ? [
          {
            code: 'other.policy_specific' as const,
            resourceIds: ['res_subject'],
            severity: 'high' as const,
            scope: 'application_local' as const,
          },
        ]
      : []);

  return {
    id: overrides.id ?? 'dec_1',
    caseId: overrides.caseId ?? 'case_1',
    revision,
    status: overrides.status ?? 'final',
    outcome,
    contextSufficiency: 'sufficient',
    confidence: 0.9,
    findings,
    recommendedActions: overrides.recommendedActions ?? [],
    jury: jury(),
    policyVersions: policyVersions(),
    // Required on every revision after the first, forbidden on the first.
    ...(revision > 1
      ? { supersedesDecisionId: overrides.supersedesDecisionId ?? 'dec_prev' }
      : {}),
    publishedAt: new Date().toISOString(),
  };
}

/** A `case.decided` webhook envelope carrying `decision`. */
export function decisionEnvelope(input: {
  eventId?: string;
  type?: string;
  decision?: Decision;
}): Record<string, unknown> {
  const payload = input.decision ?? decision();
  return {
    id: input.eventId ?? 'evt_1',
    type: input.type ?? 'case.decided',
    createdAt: new Date().toISOString(),
    // Both are required by the shared envelope shape and are easy to forget —
    // omitting them yields `malformed_event`, which reads like a signature
    // problem and is not one.
    organizationId: 'org_moovo',
    applicationId: 'app_moovo',
    data: { caseId: payload.caseId, decision: payload },
  };
}

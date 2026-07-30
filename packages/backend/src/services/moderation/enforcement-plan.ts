/**
 * Deciding what Moovo will do about a decision — and nothing else.
 *
 * Pure: no database, no clock, no configuration. A decision in, a plan out. That
 * is what makes the mapping testable as a table rather than as an integration
 * scenario, and it is why `observe` mode is a real audit rather than a comment —
 * the plan is computed identically in every mode and only its EXECUTION is gated.
 *
 * ## Moovo maps recommendations, not findings
 *
 * The jury classified the material and the consensus engine turned that into a
 * recommendation under a versioned policy. An application that re-derived its
 * action from raw severity would be quietly re-deciding the case with a second,
 * unversioned policy of its own — and the two would diverge the first time
 * CrowdSource's policy was updated. Severity is a fallback only, for a `violation`
 * that arrives with no recommendation at all, because a violation Moovo did
 * nothing about would be worse than a mapped one.
 *
 * ## The plan depends on WHO the decision is about
 *
 * This is where Moovo differs from a content application, and it is not a detail.
 * `suspend_user` is carried out when the subject is a COURIER and refused when it
 * is a customer or a delivery — because Moovo's one lever is
 * `CourierProfile.status`, and there is no schema field anywhere that stops a
 * customer from booking. A table keyed only on the recommendation would either
 * claim an effect Moovo cannot produce, or throw away a real one it can.
 *
 * And even for a courier, what Moovo does is NARROWER than what was recommended:
 * `suspend_user` means the account, and Moovo suspends courier privileges while
 * leaving the Oxy account entirely alone — suspending an Oxy account is Oxy's to
 * carry out, not Moovo's. Recording the narrower action under its own name
 * (`suspend_courier`, never `suspend_user`) is what keeps that difference visible
 * instead of letting a row imply Moovo did something it has no power to do.
 */

import type { Decision, RecommendedAction, Severity } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementAction } from '@moovo/shared-types';

/** What a decision can be about. Decides which levers are available at all. */
export type EnforcementTargetType = 'courier' | 'customer' | 'delivery';

export interface PlannedEnforcementAction {
  readonly action: ModerationEnforcementAction;
  /** Why, in words an operator reads. Never reported material. */
  readonly reason: string;
  /** The recommendation this came from, when it came from one. */
  readonly recommendedAction?: RecommendedAction;
}

/**
 * What a recommended action becomes when the subject is a courier.
 *
 * Every recommendation that means "stop this actor" collapses to the one lever
 * Moovo has. Everything that means "label it", "reduce its reach" or "age-gate
 * it" becomes `manual_review` rather than `none`: Moovo has no labelling or
 * distribution surface for a person, and silently mapping those to "do nothing"
 * would turn a real recommendation into an absent row.
 */
const COURIER_RECOMMENDATION_TO_ACTION: Readonly<
  Record<RecommendedAction, ModerationEnforcementAction>
> = Object.freeze({
  remove: 'suspend_courier',
  remove_or_restrict: 'suspend_courier',
  hide: 'suspend_courier',
  suspend_user: 'suspend_courier',

  allow: 'none',
  no_action: 'none',
  no_global_effect: 'none',
  restore: 'reinstate_courier',

  // Real recommendations Moovo holds no lever for. Recorded, queued for a human.
  label: 'manual_review',
  allow_with_label: 'manual_review',
  age_gate: 'manual_review',
  reduce_distribution: 'manual_review',
  freeze_transaction: 'manual_review',
  request_changes: 'manual_review',
  request_more_context: 'manual_review',
  hold: 'manual_review',
  local_manual_review: 'manual_review',
  keep_restricted_temporarily: 'manual_review',
  escalate: 'manual_review',
  specialist_queue: 'manual_review',
  legal_queue: 'manual_review',
  safety_queue: 'manual_review',
});

/**
 * The same, for a customer or a delivery — where Moovo has NO lever.
 *
 * Only the three "do nothing" recommendations map to `none`; everything else is a
 * human's problem. `restore` is included in that: with nothing ever suspended
 * there is nothing to reinstate, and recording a `reinstate_courier` against a
 * customer would be an action aimed at a profile that does not exist.
 */
function nonCourierAction(recommended: RecommendedAction): ModerationEnforcementAction {
  switch (recommended) {
    case 'allow':
    case 'no_action':
    case 'no_global_effect':
      return 'none';
    default:
      return 'manual_review';
  }
}

function actionFor(
  recommended: RecommendedAction,
  target: EnforcementTargetType,
): ModerationEnforcementAction {
  if (target !== 'courier') return nonCourierAction(recommended);
  return COURIER_RECOMMENDATION_TO_ACTION[recommended] ?? 'manual_review';
}

/**
 * The action a violation gets when the decision recommended nothing.
 *
 * Severity only, and deliberately cautious at BOTH ends. A `low`-severity
 * violation with no recommendation is not something to take somebody's livelihood
 * over, so it goes to a human — and `critical` goes to a human too, because a
 * safe response to critical material is a specialist under legal protocol, which
 * an automatic suspension driven by a webhook is not. The difference between them
 * is a policy decision with legal weight, and a mapping table is the wrong place
 * to make it.
 */
const SEVERITY_FALLBACK: Readonly<Record<Severity, ModerationEnforcementAction>> =
  Object.freeze({
    critical: 'manual_review',
    high: 'suspend_courier',
    medium: 'manual_review',
    low: 'manual_review',
  });

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

function highestSeverity(decision: Decision): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of decision.findings) {
    if (
      highest === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest)
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * `no_violation` always carries a reinstatement, whatever it recommended.
 *
 * This exists because of a failure that is very easy to ship and very hard to
 * see. A correction or a successful appeal is a new revision whose outcome is
 * `no_violation`, and its recommendation is frequently `no_action` — which means
 * "take no NEW action", not "leave what you already did in place". Mapping that
 * straight through plans `none`, and a courier an earlier revision suspended
 * stays suspended forever: the appeal succeeded, the case says they did nothing
 * wrong, and nothing in Moovo ever lets them work again. No error, no log line,
 * no failing test anywhere else. For a courier that is somebody's income.
 *
 * The executor records "there was nothing suspended" when that is the case, which
 * is evidence rather than a silent no-op.
 */
function withReinstateForNoViolation(
  decision: Decision,
  target: EnforcementTargetType,
  planned: readonly PlannedEnforcementAction[],
): readonly PlannedEnforcementAction[] {
  if (decision.outcome !== 'no_violation') return planned;
  if (target !== 'courier') return planned;
  if (planned.some((entry) => entry.action === 'reinstate_courier')) return planned;
  return [
    ...planned,
    {
      action: 'reinstate_courier',
      reason: 'No violation: undo any earlier suspension',
    },
  ];
}

/**
 * Collapse a plan to the actions that can coexist.
 *
 * A suspension absorbs `none` and a reinstatement — doing both would record two
 * contradictory effects for one decision. `manual_review` always survives: it is
 * a note for a human, and dropping it because something else was also done is how
 * a `legal_queue` recommendation gets lost.
 */
function collapse(actions: readonly PlannedEnforcementAction[]): PlannedEnforcementAction[] {
  const byAction = new Map<ModerationEnforcementAction, PlannedEnforcementAction>();
  for (const planned of actions) {
    if (!byAction.has(planned.action)) byAction.set(planned.action, planned);
  }

  if (byAction.has('suspend_courier')) {
    byAction.delete('reinstate_courier');
    byAction.delete('none');
  }
  if (byAction.size > 1) byAction.delete('none');

  return Array.from(byAction.values());
}

/**
 * What Moovo will do about this decision.
 *
 * Never empty: a decision that produces no action produces an explicit `none`,
 * because a row saying "we decided to do nothing, and why" is evidence and an
 * absent row is a question.
 */
export function planEnforcement(
  decision: Decision,
  target: EnforcementTargetType,
): PlannedEnforcementAction[] {
  const fromRecommendations = decision.recommendedActions.map(
    (recommended): PlannedEnforcementAction => ({
      action: actionFor(recommended.action, target),
      reason: `CrowdSource recommended ${recommended.action}`,
      recommendedAction: recommended.action,
    }),
  );

  if (fromRecommendations.length > 0) {
    const collapsed = collapse(
      withReinstateForNoViolation(decision, target, fromRecommendations),
    );
    return collapsed.length > 0
      ? collapsed
      : [{ action: 'none', reason: 'No recommended action maps to a Moovo effect' }];
  }

  switch (decision.outcome) {
    case 'violation': {
      /**
       * Only a courier can be acted on automatically at all. A violation about a
       * customer or a delivery with no recommendation is a human's call, because
       * Moovo's alternative would be to do nothing and call it handled.
       */
      if (target !== 'courier') {
        return [
          {
            action: 'manual_review',
            reason: `Violation about a ${target}: Moovo holds no automatic lever`,
          },
        ];
      }
      const severity = highestSeverity(decision);
      /**
       * A `violation` with no findings cannot happen — the contract refuses it —
       * so an absent severity here means a newer CrowdSource sent something this
       * code has not seen. A human looks at it rather than a default suspending
       * somebody.
       */
      if (severity === undefined) {
        return [
          {
            action: 'manual_review',
            reason: 'Violation carried no finding severity this version understands',
          },
        ];
      }
      return [
        {
          action: SEVERITY_FALLBACK[severity],
          reason: `Violation with no recommended action, highest severity ${severity}`,
        },
      ];
    }

    case 'no_violation':
      /**
       * A reinstatement, always planned — even when nothing was suspended. The
       * executor records it as not applied with the reason, which is how "we
       * checked and there was nothing to undo" stays distinguishable from "we
       * never looked".
       */
      return target === 'courier'
        ? [{ action: 'reinstate_courier', reason: 'No violation: undo any earlier suspension' }]
        : [{ action: 'none', reason: 'No violation, and nothing was ever restricted' }];

    case 'insufficient_context':
    case 'inconclusive':
    case 'escalated':
      /**
       * None of these is "act" and none is "it was fine": absence of consensus is
       * neither guilt nor innocence, so Moovo changes nothing on its own and asks
       * a human.
       */
      return [
        {
          action: 'manual_review',
          reason: `Outcome ${decision.outcome}: no automatic action, internal review`,
        },
      ];

    case 'content_unavailable':
    case 'duplicate':
      return [{ action: 'none', reason: `Outcome ${decision.outcome}: nothing to enforce` }];

    default:
      /**
       * An outcome this version does not define. A newer server must not break an
       * older client, and the safe reading of an unknown outcome is a human,
       * never a default effect.
       */
      return [
        {
          action: 'manual_review',
          reason: 'Decision outcome not recognised by this version of Moovo',
        },
      ];
  }
}

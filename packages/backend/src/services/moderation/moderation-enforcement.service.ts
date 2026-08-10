/**
 * Carrying out a plan, idempotently, and writing down what happened either way.
 *
 * Two properties matter more than the effects themselves:
 *
 * 1. **Every action claims its row BEFORE acting** and releases it if the effect
 *    throws. The claim is a unique-index insert on
 *    `decisionId + revision + action`, so a redelivered webhook, a reclaimed
 *    outbox lease or two ECS tasks racing the same decision all converge on one
 *    row and one effect.
 * 2. **A row is written even when nothing happened.** `applied: false` with a
 *    reason is evidence; an absent row is a question. That is what makes
 *    `observe` mode a real audit rather than a comment: the plan is computed and
 *    recorded identically in every mode, and only the effect is gated.
 */

import type { ModerationEnforcementAction, ModerationEnforcementMode } from '@moovo/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  reinstateCourier as reinstateCourierRow,
  suspendCourier as suspendCourierRow,
} from '../../db/fleet/courierProfileRepository.js';
import {
  claimModerationEnforcement,
  deleteModerationEnforcement,
  recordModerationEnforcementEffect,
} from '../../db/moderation/moderationEnforcementRepository.js';
import type { EnforcementTargetType, PlannedEnforcementAction } from './enforcement-plan.js';

/**
 * Which actions each mode is allowed to actually perform.
 *
 * `observe` performs nothing. `manual` performs only the give-something-back half
 * — reinstating a courier an earlier revision suspended is the one effect that
 * cannot harm anyone by being automatic, and withholding it until a human notices
 * is how a successful appeal turns into weeks of lost income. `automatic`
 * performs everything the plan contains.
 *
 * `manual_review` and `none` are never "performed" in any mode: there is no
 * effect to perform, only a row to write.
 */
const APPLICABLE_ACTIONS: Readonly<
  Record<ModerationEnforcementMode, ReadonlySet<ModerationEnforcementAction>>
> = Object.freeze({
  observe: new Set<ModerationEnforcementAction>(),
  manual: new Set<ModerationEnforcementAction>(['reinstate_courier']),
  automatic: new Set<ModerationEnforcementAction>(['suspend_courier', 'reinstate_courier']),
});

export interface EnforcementInput {
  readonly decisionId: string;
  readonly revision: number;
  readonly caseId?: string;
  readonly reportId?: string;
  readonly targetType: EnforcementTargetType;
  readonly targetId: string;
  readonly planned: readonly PlannedEnforcementAction[];
}

interface EffectResult {
  applied: boolean;
  /** Overrides the planned reason when the effect had something to say. */
  reason?: string;
}

/**
 * Suspend a courier's ability to take work. Never touches the Oxy account.
 *
 * Scoped to a profile that is not ALREADY suspended, so a redelivery cannot
 * report a second suspension of the same courier as a fresh effect. A courier
 * with no Moovo profile at all is a real outcome — a customer reported under the
 * `courier` type, or a profile deleted since — and is recorded as not applied
 * rather than silently succeeding.
 */
async function suspendCourier(oxyUserId: string): Promise<EffectResult> {
  // The repository answers the same question `matchedCount === 0` answered:
  // did this statement actually change a courier's status. Both predicates
  // exclude the no-change case, so Mongo's matchedCount and Postgres' row
  // count cannot disagree here — see the repository's own note.
  const suspended = await suspendCourierRow(oxyUserId);
  if (!suspended) {
    return { applied: false, reason: 'No active courier profile to suspend' };
  }
  return { applied: true };
}

/**
 * Undo a suspension.
 *
 * Restores to `active` rather than to whatever the profile held before, and only
 * from `suspended` — a profile still `pending` verification was never suspended
 * by us and must not be promoted to `active` by an unrelated appeal. Onboarding
 * state is not ours to skip.
 */
async function reinstateCourier(oxyUserId: string): Promise<EffectResult> {
  const reinstated = await reinstateCourierRow(oxyUserId);
  if (!reinstated) {
    return { applied: false, reason: 'There was no suspension to undo' };
  }
  return { applied: true };
}

/**
 * Perform one action, or explain why it was not performed.
 *
 * A `courier` action against a non-courier target never runs: the plan should not
 * produce one, and a defence here costs nothing against the cost of suspending
 * the wrong kind of account.
 */
async function performEffect(
  action: ModerationEnforcementAction,
  target: EnforcementTargetType,
  targetId: string,
  mode: ModerationEnforcementMode,
): Promise<EffectResult> {
  if (!APPLICABLE_ACTIONS[mode].has(action)) {
    return {
      applied: false,
      reason:
        action === 'manual_review' || action === 'none'
          ? undefined
          : `Enforcement mode '${mode}' records this action without applying it`,
    };
  }
  if (target !== 'courier') {
    return { applied: false, reason: `Action '${action}' does not apply to a ${target}` };
  }

  switch (action) {
    case 'suspend_courier':
      return await suspendCourier(targetId);
    case 'reinstate_courier':
      return await reinstateCourier(targetId);
    default:
      return { applied: false };
  }
}

/**
 * Claim the row for one action, or discover somebody already has it.
 *
 * The insert IS the claim, against `moderation_enforcements_decision_revision_
 * action_key`. The source inserted and caught the driver's duplicate-key error;
 * that shape does not port, because a raised `23505` aborts the surrounding
 * transaction and a decision plans SEVERAL actions — one already-claimed action
 * would abandon the others. `claimModerationEnforcement` asks for
 * `ON CONFLICT DO NOTHING RETURNING` instead, so `null` is the answer "this
 * exact action of this exact revision has already been handled", raised by
 * nothing.
 */
async function claim(
  input: EnforcementInput,
  planned: PlannedEnforcementAction,
): Promise<string | null> {
  return await claimModerationEnforcement({
    decisionId: input.decisionId,
    revision: input.revision,
    action: planned.action,
    caseId: input.caseId,
    reportId: input.reportId,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: planned.reason,
  });
}

export interface EnforcementOutcome {
  claimed: number;
  applied: number;
}

/**
 * Apply a plan.
 *
 * Actions are performed in sequence rather than in parallel: the set is at most a
 * handful, they can contradict each other, and a deterministic order makes the
 * recorded trail readable.
 */
export async function applyEnforcementPlan(
  input: EnforcementInput,
): Promise<EnforcementOutcome> {
  const mode = config.crowdSource.enforcementMode;
  let claimed = 0;
  let applied = 0;

  for (const planned of input.planned) {
    const rowId = await claim(input, planned);
    if (rowId === null) continue;
    claimed += 1;

    let effect: EffectResult;
    try {
      effect = await performEffect(planned.action, input.targetType, input.targetId, mode);
    } catch (error: unknown) {
      /**
       * Release the claim so the work is retried. Keeping a claimed row whose
       * effect threw would mark the action permanently done without it ever
       * having happened — the exact shape of a silently lost enforcement.
       */
      await deleteModerationEnforcement(rowId);
      claimed -= 1;
      log.moderation.error(
        { err: error, decisionId: input.decisionId, action: planned.action },
        '[CrowdSource] enforcement effect failed, claim released',
      );
      throw error;
    }

    await recordModerationEnforcementEffect(rowId, {
      applied: effect.applied,
      reason: effect.reason,
    });
    if (effect.applied) applied += 1;
  }

  log.moderation.info(
    {
      decisionId: input.decisionId,
      revision: input.revision,
      targetType: input.targetType,
      mode,
      claimed,
      applied,
    },
    '[CrowdSource] enforcement plan handled',
  );
  return { claimed, applied };
}

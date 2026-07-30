/**
 * Applying one decision that came back from CrowdSource.
 *
 * Runs off the outbox, not off the webhook, so a burst of decisions cannot time
 * the receiver out and a failure here retries with backoff instead of asking
 * CrowdSource to redeliver.
 *
 * The order is deliberate: parse, find the report, plan, enforce, then update the
 * report. Enforcement before the status write means a decision whose effect threw
 * leaves the report at its previous status and the outbox event retried — the
 * alternative would mark a report closed on a case whose consequence never
 * happened.
 */

import { DecisionSchema, type Decision } from '@oxyhq/crowdsource-contracts';
import { log } from '../../lib/logger.js';
import { Report, type IReport } from '../../models/report.js';
import { planEnforcement, type EnforcementTargetType } from './enforcement-plan.js';
import { applyEnforcementPlan } from './moderation-enforcement.service.js';
import type { ModerationOutboxEvent } from './moderation-outbox.service.js';
import { reportStateForDecision } from './report-status.js';

/**
 * A decision payload that is not a decision.
 *
 * `retryable: false`: no number of retries turns a malformed payload into a valid
 * one, so the outbox dead-letters it and the reconciliation sweep counts it.
 */
export class ModerationDecisionRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDecisionRejectedError';
  }
}

/**
 * Which of Moovo's nouns a decision is about.
 *
 * Read from the local report rather than from the decision, because the decision
 * does not carry it — a `Decision` names its case, not its subject. The report is
 * the only place the mapping from a case back to "this was a courier" exists, and
 * it is also what makes the enforcement target trustworthy: it was written by
 * Moovo at intake, not by anything that arrived over the wire.
 */
function targetFor(report: Pick<IReport, 'reportedType' | 'reportedId'>): {
  targetType: EnforcementTargetType;
  targetId: string;
} | null {
  switch (report.reportedType) {
    case 'courier':
    case 'customer':
    case 'delivery':
      return { targetType: report.reportedType, targetId: report.reportedId };
    default:
      /**
       * A decision about a type with no provider is impossible by construction —
       * such a report is never delivered, so no case exists to decide. Reaching
       * here means a case was opened by something other than this pipeline.
       */
      return null;
  }
}

/** Handle one `decision.apply` outbox event. */
export async function applyDecisionOutboxEvent(event: ModerationOutboxEvent): Promise<void> {
  const caseId = event.payload.caseId;
  if (caseId === undefined) {
    throw new ModerationDecisionRejectedError('A decision.apply event carried no caseId.');
  }

  /**
   * Parsed against the published contract HERE rather than at the webhook.
   *
   * The receiver stores what arrived and answers fast; this is the first place
   * that has to understand it. A payload that fails the contract is a defect
   * worth dead-lettering, and doing it here means the raw event is still on
   * record to look at.
   */
  const parsed = DecisionSchema.safeParse(event.payload.decision);
  if (!parsed.success) {
    throw new ModerationDecisionRejectedError(
      `Decision payload for case '${caseId}' does not satisfy the published contract: ${parsed.error.message.slice(0, 500)}`,
    );
  }
  const decision: Decision = parsed.data;

  const report = await Report.findOne({ crowdSourceCaseId: caseId }).lean();
  if (!report) {
    /**
     * A decision for a case this deployment has no report for. Not retryable and
     * not an error to fix here: the likeliest cause is a case merged into another
     * tenant's, or a report deleted. Logged and completed, because retrying will
     * never find it.
     */
    log.moderation.warn({ caseId }, '[CrowdSource] decision has no local report');
    return;
  }

  const target = targetFor(report);
  if (target === null) {
    throw new ModerationDecisionRejectedError(
      `Report '${String(report._id)}' has reported type '${report.reportedType}', which is not deliverable and cannot have a case.`,
    );
  }

  const planned = planEnforcement(decision, target.targetType);
  await applyEnforcementPlan({
    decisionId: decision.id,
    revision: decision.revision,
    caseId,
    reportId: String(report._id),
    targetType: target.targetType,
    targetId: target.targetId,
    planned,
  });

  const state = reportStateForDecision({
    outcome: decision.outcome,
    decisionStatus: decision.status,
  });

  /**
   * Guarded on the revision so an out-of-order delivery cannot roll the report
   * back to a superseded answer.
   *
   * This is a real ordering hazard rather than a theoretical one: a correction
   * and the decision it supersedes are separate webhook events with separate
   * retry schedules, so revision 1 can arrive — or be retried — after revision 2
   * has already been applied. Without the filter, a retry of the original
   * suspension decision would overwrite an accepted appeal's `dismissed` with
   * `resolved`, and the report would say the courier was found in violation of
   * something they had been cleared of.
   *
   * `$lt` on the recorded revision, with `$exists: false` for the first decision
   * a report ever receives. A stale revision matches nothing and writes nothing;
   * its enforcement was already claimed under its own `revision` row, so the
   * audit trail keeps both and only the CURRENT answer reaches the report.
   */
  await Report.updateOne(
    {
      _id: report._id,
      $or: [
        { decisionRevision: { $exists: false } },
        { decisionRevision: { $lt: decision.revision } },
      ],
    },
    {
      $set: {
        status: state.status,
        localStatus: state.localStatus,
        decisionRevision: decision.revision,
      },
    },
  );

  log.moderation.info(
    {
      caseId,
      decisionId: decision.id,
      revision: decision.revision,
      outcome: decision.outcome,
      reportId: String(report._id),
    },
    '[CrowdSource] decision applied',
  );
}

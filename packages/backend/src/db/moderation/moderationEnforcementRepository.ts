/**
 * Every statement this service issues against `moderation_enforcements`.
 *
 * One row per thing Moovo did, or deliberately did not do, about a decision.
 *
 * ## The claim is the unique index, and `revision` is the part that must not go
 *
 * `UNIQUE(decision_id, revision, action)` is what makes enforcement idempotent:
 * inserting the row IS the claim to perform that action, so a redelivered
 * decision finds the row already there and does not act twice.
 *
 * `revision` is easy to drop and expensive to lose. A correction or a
 * successful appeal is a NEW revision of the same decision, and its `restore`
 * must be a DIFFERENT action from the removal it supersedes. Leave `revision`
 * out of the key and the restore collides with the earlier row, reads as
 * already applied, and an accepted appeal can never put anything back — with no
 * error anywhere.
 *
 * ## And the claim must not RAISE
 *
 * The source inserts and catches the duplicate-key error. In Postgres a raised
 * `23505` aborts the surrounding transaction, so the empty-vs-one-row
 * `RETURNING` of `ON CONFLICT DO NOTHING` is the only shape that leaves the
 * caller able to carry on — which it must, because a decision plans SEVERAL
 * actions and one already-claimed action must not abandon the others.
 */

import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { moderationEnforcements } from '../schema/moderation';

/** What claiming one action needs. */
export interface NewModerationEnforcement {
  decisionId: string;
  revision: number;
  action: string;
  caseId?: string | undefined;
  reportId?: string | undefined;
  targetType: string;
  targetId: string;
  reason: string;
}

/**
 * Claim one action of one decision revision, or report it already claimed.
 *
 * Returns the new row's id on a win, `null` when the unique index says another
 * delivery got there first. No error is raised in either case.
 */
export async function claimModerationEnforcement(
  input: NewModerationEnforcement,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const [row] = await db
    .insert(moderationEnforcements)
    .values({
      id: uuidv7(),
      decisionId: input.decisionId,
      revision: input.revision,
      action: input.action,
      caseId: input.caseId ?? null,
      reportId: input.reportId ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      applied: false,
      reason: input.reason,
    })
    .onConflictDoNothing({
      target: [
        moderationEnforcements.decisionId,
        moderationEnforcements.revision,
        moderationEnforcements.action,
      ],
    })
    .returning({ id: moderationEnforcements.id });
  return row?.id ?? null;
}

/**
 * Record what the effect actually was.
 *
 * `applied: false` is a real outcome, not a failure — it is what `observe` mode
 * writes, and also what a genuinely-nothing-to-do action writes. The reason is
 * what keeps "we checked and there was nothing to undo" distinct from "we never
 * looked", so it is updated whenever the effect supplies one.
 */
export async function recordModerationEnforcementEffect(
  id: string,
  effect: { applied: boolean; reason?: string | undefined; appliedAt?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEnforcements)
    .set({
      applied: effect.applied,
      ...(effect.reason === undefined ? {} : { reason: effect.reason }),
      ...(effect.applied ? { appliedAt: effect.appliedAt ?? new Date() } : {}),
    })
    .where(eq(moderationEnforcements.id, id));
}

/**
 * Drop a claim whose effect could not even be attempted.
 *
 * The claim is only meaningful while it stands for work that happened or was
 * decided against. A claim left behind after the effect threw would make the
 * next delivery treat an enforcement that never ran as already applied — the
 * exact shape of a silently lost enforcement.
 */
export async function deleteModerationEnforcement(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEnforcements).where(eq(moderationEnforcements.id, id));
}

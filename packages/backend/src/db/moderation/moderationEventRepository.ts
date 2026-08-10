/**
 * Every statement this service issues against `moderation_events`.
 *
 * Two jobs in one table, and they are the same job: the row is the DEDUPE CLAIM
 * for a webhook delivery, and it is the AUDIT ROW answering "did CrowdSource
 * tell us about this case, and when".
 *
 * ## The claim must not raise, and here that is mandatory rather than tidier
 *
 * The source INSERTS and treats a duplicate-key error as the answer "somebody
 * else has this event". That shape cannot port: in Postgres a raised `23505`
 * aborts the whole transaction, so every statement after it fails too — and the
 * webhook path runs inside one. `INSERT … ON CONFLICT (id) DO NOTHING
 * RETURNING id` makes the EMPTY result the answer instead, with no error raised
 * and nothing to recover from.
 *
 * The claim being the INSERT is why this works across ECS tasks at all: Moovo
 * runs several behind one ALB, so the SDK's in-process default store would
 * dedupe only the instance that happened to receive both copies.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { moderationEvents } from '../schema/moderation';

/** Comfortably longer than any sender-side retry schedule. */
export const MODERATION_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Claim an event id, or report that somebody already holds it.
 *
 * `true` means this process owns the event. `false` means a concurrent
 * redelivery claimed it first — an ANSWER, not a failure, and it arrives with
 * no error raised so the caller's transaction stays usable.
 *
 * A real fault (a lost connection, a failover) still throws, which is what
 * makes the middleware answer non-2xx and leaves the event on the sender's
 * retry schedule. Swallowing it here would answer 200 and retire a decision
 * nobody ever handled.
 */
export async function claimModerationEvent(
  eventId: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(moderationEvents)
    .values({
      id: eventId,
      state: 'claimed',
      receivedAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: moderationEvents.id })
    .returning({ id: moderationEvents.id });
  return rows.length === 1;
}

/** Give the claim back so a redelivery can be processed. */
export async function releaseModerationEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEvents).where(eq(moderationEvents.id, eventId));
}

/**
 * Record that an event carried work, and what it was.
 *
 * A plain UPDATE, not an upsert: the row already exists because claiming it is
 * what let this code run at all. An upsert here would quietly resurrect an
 * event whose claim had been released.
 */
export async function markModerationEventQueued(
  input: {
    eventId: string;
    type: string;
    caseId?: string | undefined;
    payload: unknown;
    queuedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEvents)
    .set({
      type: input.type,
      caseId: input.caseId ?? null,
      payload: input.payload,
      state: 'queued',
      queuedAt: input.queuedAt,
    })
    .where(eq(moderationEvents.id, input.eventId));
}

/**
 * Record that an event carried nothing to enforce.
 *
 * `case.created`, `case.closed` and any type a newer CrowdSource introduces are
 * recorded as `ignored` rather than dropped — "did they tell us" is the first
 * question asked when a report looks stuck, and the answer has to exist.
 *
 * `caseId` is left ALONE when absent rather than nulled: the claim may have
 * recorded one, and an update that blanked it would destroy the only link
 * between the event and the case it belonged to.
 */
export async function markModerationEventIgnored(
  input: { eventId: string; type: string; caseId?: string | undefined },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEvents)
    .set({
      type: input.type,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      state: 'ignored',
    })
    .where(eq(moderationEvents.id, input.eventId));
}

/** Whether an event row exists at all, for the operator trace. */
export async function moderationEventExists(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(moderationEvents)
    .where(eq(moderationEvents.id, eventId))
    .limit(1);
  return row !== undefined;
}

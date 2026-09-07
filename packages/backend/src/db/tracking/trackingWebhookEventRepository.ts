/**
 * Every statement this service issues against `tracking_webhook_events`.
 *
 * The table is a dedupe CLAIM with an audit trail attached, modelled on
 * `moderation_events` — and the one thing that must not change is that
 * **claiming never RAISES**.
 *
 * A carrier redelivers. Two tasks can receive the same delivery at once. The
 * losing insert gets `23505`, and in Postgres a raised duplicate-key aborts the
 * surrounding transaction, so every later statement fails with `25P02` — and
 * this claim runs inside one, beside the update that schedules the parcel.
 * `ON CONFLICT DO NOTHING RETURNING` makes the empty result the answer instead.
 */

import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { trackingWebhookEvents } from '../schema/tracking';
import { TRACKING_WEBHOOK_EVENT_RETENTION_SECONDS } from './retention';

export type TrackingWebhookEventRow = typeof trackingWebhookEvents.$inferSelect;

export interface ClaimWebhookEventInput {
  /** The carrier's own delivery id, or `sha256(carrierKey|rawBody)` when it sends none. */
  id: string;
  carrierKey: string;
  type?: string | undefined;
  payload: unknown;
  now?: Date;
}

/**
 * Claim one delivery. `true` means this task owns it; `false` means another
 * already does, which is an answer rather than a failure.
 */
export async function claimTrackingWebhookEvent(
  input: ClaimWebhookEventInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const claimed = await db
    .insert(trackingWebhookEvents)
    .values({
      id: input.id,
      carrierKey: input.carrierKey,
      type: input.type ?? null,
      payload: input.payload as Record<string, unknown>,
      state: 'claimed',
      receivedAt: now,
      expiresAt: new Date(now.getTime() + TRACKING_WEBHOOK_EVENT_RETENTION_SECONDS * 1000),
    })
    .onConflictDoNothing({ target: trackingWebhookEvents.id })
    .returning({ id: trackingWebhookEvents.id });

  return claimed.length > 0;
}

/** Mark a claimed delivery as handed to the poller. */
export async function markWebhookEventQueued(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(trackingWebhookEvents)
    .set({ state: 'queued', queuedAt: new Date() })
    .where(eq(trackingWebhookEvents.id, id));
}

/** Mark a delivery we understood but chose not to act on. */
export async function markWebhookEventIgnored(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(trackingWebhookEvents)
    .set({ state: 'ignored' })
    .where(eq(trackingWebhookEvents.id, id));
}

export async function findWebhookEvent(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingWebhookEventRow | null> {
  const [row] = await db
    .select()
    .from(trackingWebhookEvents)
    .where(eq(trackingWebhookEvents.id, id))
    .limit(1);
  return row ?? null;
}

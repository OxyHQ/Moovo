/**
 * The webhook dedupe store, shared by every task.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Moovo
 * runs on ECS Fargate behind the shared ALB, so this is that case.
 *
 * The name says SHARED rather than naming the database, and that is deliberate:
 * the property the SDK's default lacks is that this store is visible to every
 * task, not which engine holds it. The previous name said `mongo`, which is how
 * a rename becomes due again the next time the storage moves.
 *
 * The claim/release contract is the store's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means the sender's retry schedule
 * can still deliver the event later. Recording the id only after success would
 * let two copies run at once; recording it before and never releasing would make
 * a transient failure permanent and lose a decision silently.
 *
 * ## The duplicate is an ANSWER here, and it no longer arrives as an error
 *
 * The source inserted and caught the driver's duplicate-key error. That shape
 * cannot survive the port: a raised `23505` aborts the surrounding transaction,
 * so every later statement in it fails too. `claimModerationEvent` asks the
 * database for `ON CONFLICT DO NOTHING RETURNING`, which makes the EMPTY result
 * the answer with nothing raised — so there is no error class to recognise here
 * any more, and no way for a future caller to mistake a real fault for a
 * duplicate.
 */

import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import {
  claimModerationEvent,
  releaseModerationEvent,
} from '../../db/moderation/moderationEventRepository.js';

export function sharedProcessedEventStore(): ProcessedEventStore {
  return {
    /**
     * True when this call took the claim.
     *
     * The insert IS the claim: the row's primary key is the event id, so an
     * empty `RETURNING` is the answer "somebody else has this event" rather
     * than a failure to work around.
     *
     * Anything else — a lost connection, a failover — still throws, and is NOT
     * "already processed". Letting it propagate makes the middleware answer
     * non-2xx so the event stays on the sender's retry schedule; swallowing it
     * here would answer 200 and retire a decision nobody ever handled.
     */
    async claim(eventId: string): Promise<boolean> {
      return await claimModerationEvent(eventId);
    },

    /** Give the claim back so a redelivery can be processed. */
    async release(eventId: string): Promise<void> {
      await releaseModerationEvent(eventId);
    },
  };
}

/**
 * How long a tracked parcel is kept, and why there are two answers.
 *
 * `tracked_parcels` is a table ANY caller can write to by pasting a string —
 * the anonymous lookup creates a row so the identity can be shared and the
 * carrier called once. That makes retention a bound on an open-ended table, not
 * a filing policy, so it cannot be left unregistered the way
 * `job_location_pings` is.
 *
 * `ExpirySweepTarget` has no predicate field, so both policies have to arrive
 * as one already-computed deadline in `tracked_parcels.expires_at`, written by
 * the application on every write. That is the same shape
 * `moderation_outboxes.expires_at` uses, and it carries the same HAZARD:
 * the deadline is set when the row is WRITTEN, not when the parcel finishes, so
 * a poller wedged for a whole retention window would have live parcels aged out
 * by the sweep rather than delivered. Alert on poller staleness; the sweep is
 * only what makes that incident lossy.
 *
 * Both numbers are recorded in AGENTS.md as an open product decision. Changing
 * either is changing a constant here.
 */

/**
 * A parcel nobody watches — a typo, an abandoned paste, a one-off anonymous
 * lookup. This is the number that actually bounds the table.
 */
export const TRACKED_PARCEL_UNWATCHED_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * A parcel somebody watches, measured from the moment it stopped moving.
 *
 * Deliberately generous: "where did that package go in March" is a question
 * people genuinely ask, and the row is small.
 */
export const TRACKED_PARCEL_WATCHED_RETENTION_SECONDS = 180 * 24 * 60 * 60;

/** Carrier pushes are a dedupe claim plus an audit trail, well past any retry schedule. */
export const TRACKING_WEBHOOK_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The deadline to store on a parcel row, given what is true of it right now.
 *
 * Called on EVERY write to the row, so a parcel that keeps moving keeps pushing
 * its own deadline out, and one that loses its last subscriber falls back to
 * the short window on that same write.
 */
export function trackedParcelExpiresAt(input: {
  now: Date;
  subscriberCount: number;
  /** When the parcel reached a terminal status, if it has. */
  terminalAt: Date | null;
}): Date {
  if (input.subscriberCount <= 0) {
    return new Date(input.now.getTime() + TRACKED_PARCEL_UNWATCHED_RETENTION_SECONDS * 1000);
  }
  const from = input.terminalAt ?? input.now;
  return new Date(from.getTime() + TRACKED_PARCEL_WATCHED_RETENTION_SECONDS * 1000);
}

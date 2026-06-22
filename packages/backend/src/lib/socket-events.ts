/**
 * Socket.IO event names for the Moovo transport domain.
 *
 * One frozen registry of event-name string literals so no raw strings are
 * scattered across emit sites. Every event is delivered to the SERVER-VERIFIED
 * `user:<oxyUserId>` room (see `socket.ts`) — never a client-named room.
 *
 * - `JOB_OFFER` → a candidate courier receives a time-boxed dispatch offer.
 * - `JOB_OFFER_TAKEN` → a losing candidate is told their offer was superseded.
 * - `JOB_ACCEPTED` → the sender is told their job was accepted by a courier.
 * - `JOB_LOCATION` → the sender receives a live courier location ping.
 * - `JOB_PICKED_UP` / `JOB_IN_TRANSIT` / `JOB_DELIVERED` / `JOB_CANCELLED` →
 *   the sender (and assigned courier) receive the job's lifecycle transitions.
 */
export const EVENTS = {
  /** A candidate courier received a dispatch offer (`JobOfferView` payload). */
  JOB_OFFER: 'job:offer',
  /** A losing candidate's offer was superseded by another courier's accept. */
  JOB_OFFER_TAKEN: 'job:offer_taken',
  /** A job was accepted by a courier (sent to the sender). */
  JOB_ACCEPTED: 'job:accepted',
  /** A live courier location ping (sent to the sender during an active job). */
  JOB_LOCATION: 'job:location',
  /** A job was marked picked up. */
  JOB_PICKED_UP: 'job:picked_up',
  /** A job entered transit. */
  JOB_IN_TRANSIT: 'job:in_transit',
  /** A job was delivered. */
  JOB_DELIVERED: 'job:delivered',
  /** A job was cancelled. */
  JOB_CANCELLED: 'job:cancelled',
} as const;

/** Union of every Moovo transport socket event name. */
export type JobSocketEvent = (typeof EVENTS)[keyof typeof EVENTS];

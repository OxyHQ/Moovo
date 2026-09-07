/**
 * The tracking vocabulary's two derived facts: what is terminal, and how a
 * Moovo job is projected into it.
 *
 * Both live in code rather than in a column because both are PARTITIONS of
 * `TRACKING_STATUSES`, not value sets of their own. A second closed set that
 * has to agree with the first is a second thing to keep in step.
 */

import { TRACKING_STATUSES, type JobStatus, type TrackingStatus } from '@moovo/shared-types';

/**
 * Statuses a parcel never leaves, and therefore is never fetched again in.
 *
 * `returned` and `cancelled` are terminal alongside the obvious two: a parcel
 * that went back to the sender has finished moving, and continuing to ask about
 * it is spend with no possible answer. A late "actually it moved again" arrives
 * by webhook or not at all.
 */
export const TRACKING_TERMINAL_STATUSES: readonly TrackingStatus[] = [
  'delivered',
  'returned',
  'expired',
  'cancelled',
];

export function isTerminalTrackingStatus(status: TrackingStatus): boolean {
  return TRACKING_TERMINAL_STATUSES.includes(status);
}

/**
 * A Moovo job's status, in the tracker's words.
 *
 * One mapping deserves its argument, because it reads like a mistake:
 * **`in_transit` becomes `out_for_delivery`.** Moovo's `in_transit` means a
 * courier has the parcel and is riding to the door — a same-city run, minutes
 * away. A carrier's `in_transit` means it is somewhere in a network, possibly
 * for days. The tracker's vocabulary describes what the RECIPIENT should
 * expect, so mapping Moovo's leg onto `in_transit` would tell them to wait when
 * somebody is about to ring the bell.
 *
 * `picked_up` therefore covers the earlier leg, where the courier has it but is
 * not yet approaching.
 */
const JOB_STATUS_TO_TRACKING: Record<JobStatus, TrackingStatus> = {
  requested: 'pending',
  offered: 'pending',
  accepted: 'info_received',
  picked_up: 'in_transit',
  in_transit: 'out_for_delivery',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

export function jobStatusToTrackingStatus(status: JobStatus): TrackingStatus {
  return JOB_STATUS_TO_TRACKING[status];
}

/** Every tracking status, for exhaustiveness checks in tests. */
export const ALL_TRACKING_STATUSES: readonly TrackingStatus[] = TRACKING_STATUSES;

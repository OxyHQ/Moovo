import type { JobStatus, JobView } from "@moovo/shared-types";
import type { ScanLeg } from "@/lib/job-codes";

/**
 * Status → courier-action mapping for the active-job step flow (PURE).
 *
 * Drives the single primary action shown on the active-job screen for each
 * lifecycle state the assigned courier can act on:
 *   accepted    → navigate to pickup, then SCAN the pickup QR (→ picked_up)
 *   picked_up   → start delivery (→ in_transit)
 *   in_transit  → navigate to dropoff, then SCAN the delivery QR (→ delivered)
 * `delivered` / `cancelled` are terminal (no action). `requested`/`offered`
 * aren't actionable from this screen (the offer is handled on home).
 */

/** Which primary action the courier takes next. */
export type JobAction =
  | { kind: "scan"; leg: ScanLeg; label: string; navLabel: string }
  | { kind: "transition"; transition: "in-transit"; label: string }
  | { kind: "none" };

/** Whether the job is in a leg where the courier should be streaming location. */
export function isActiveLeg(status: JobStatus): boolean {
  return status === "accepted" || status === "picked_up" || status === "in_transit";
}

/** Whether the job has reached a terminal state. */
export function isTerminal(status: JobStatus): boolean {
  return status === "delivered" || status === "cancelled";
}

/** The navigation target endpoint (pickup until picked up, then dropoff). */
export function navTarget(job: JobView): JobView["pickupSnapshot"] | null {
  if (job.status === "accepted") return job.pickupSnapshot;
  if (job.status === "picked_up" || job.status === "in_transit") {
    return job.dropoffSnapshot;
  }
  return null;
}

/** The primary action for the current status. */
export function actionForStatus(status: JobStatus): JobAction {
  switch (status) {
    case "accepted":
      return {
        kind: "scan",
        leg: "pickup",
        label: "Scan QR at pickup",
        navLabel: "Navigate to pickup",
      };
    case "picked_up":
      return { kind: "transition", transition: "in-transit", label: "Start delivery" };
    case "in_transit":
      return {
        kind: "scan",
        leg: "dropoff",
        label: "Scan QR at delivery",
        navLabel: "Navigate to dropoff",
      };
    default:
      return { kind: "none" };
  }
}

/** A short, human label for a job status (e.g. for a status pill). */
export function statusLabel(status: JobStatus): string {
  switch (status) {
    case "requested":
      return "Requested";
    case "offered":
      return "Offered";
    case "accepted":
      return "Accepted";
    case "picked_up":
      return "Picked up";
    case "in_transit":
      return "In transit";
    case "delivered":
      return "Delivered";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

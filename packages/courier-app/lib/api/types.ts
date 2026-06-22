import type {
  JobView,
  JobSummary,
  JobOfferView,
  Vehicle,
  CourierProfile,
} from "@moovo/shared-types";

/**
 * Frontend-facing aliases for the backend wire DTOs, kept in one place so screens
 * import a single, stable surface. These re-point at the canonical
 * `@moovo/shared-types` contract — no shapes are redefined here.
 */
export type {
  JobView,
  JobSummary,
  JobOfferView,
  Vehicle,
  CourierProfile,
};

/**
 * A live courier location ping pushed over the `job:location` socket event while
 * a job is active. The backend emits the assigned courier's last point so the
 * sender (and the courier's own map) can track movement.
 */
export interface JobLocationEvent {
  /** The job the ping belongs to. */
  jobId: string;
  /** `[lng, lat]` per GeoJSON. */
  coordinates: [number, number];
  /** ISO-8601 time of the ping. */
  at: string;
}

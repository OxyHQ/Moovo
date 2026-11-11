import type { GeoPoint, JobStatus } from '@moovo/shared-types';

/** Payload for the job lifecycle transition events (accepted → cancelled). */
export interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  jobNumber: string;
}

/** Payload for the live courier-location event (`job:location`). */
export interface JobLocationPayload {
  jobId: string;
  location: GeoPoint;
  at: string;
}

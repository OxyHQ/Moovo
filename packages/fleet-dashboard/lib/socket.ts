import type { OxyServices } from '@oxy.so/core';
import type { GeoPoint, JobStatus, JobOfferView } from '@moovo/shared-types';
import { createSessionSocket } from '../../../shared/session-socket';
import config from './config';

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

/** The server→client events this dashboard listens for, with their payloads. */
export interface JobServerToClientEvents {
  'job:offer': (offer: JobOfferView) => void;
  'job:offer_taken': (payload: { jobId: string; offerId: string }) => void;
  'job:accepted': (payload: JobStatusPayload) => void;
  'job:picked_up': (payload: JobStatusPayload) => void;
  'job:in_transit': (payload: JobStatusPayload) => void;
  'job:delivered': (payload: JobStatusPayload) => void;
  'job:cancelled': (payload: JobStatusPayload) => void;
  'job:location': (payload: JobLocationPayload) => void;
}

/** Each subscriber owns and disposes its connection; rooms remain server-verified. */
export function openMoovoSocket(oxy: OxyServices) {
  return createSessionSocket(oxy, config.apiUrl);
}

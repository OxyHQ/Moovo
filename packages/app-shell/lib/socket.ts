import type { OxyServices } from '@oxy.so/core';
import { createSessionSocket } from '../../../shared/session-socket';
import config from './config';

/** Each subscriber owns and disposes its connection; rooms remain server-verified. */
export function openMoovoSocket(oxy: OxyServices) {
  return createSessionSocket(oxy, config.apiUrl);
}

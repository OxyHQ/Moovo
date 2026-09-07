/**
 * The projection of a Moovo job into the tracker's vocabulary.
 *
 * Exhaustive by iteration over `JOB_STATUSES`, not by spot check: a job status
 * with no mapping would render as `undefined` in a list the user is reading,
 * and the gap would appear only for whichever status nobody thought of.
 */

import { describe, expect, it } from 'vitest';
import { TRACKING_STATUSES, type JobStatus } from '@moovo/shared-types';
import { JOB_STATUSES } from '../../../db/schema/valueSets.js';
import {
  TRACKING_TERMINAL_STATUSES,
  isTerminalTrackingStatus,
  jobStatusToTrackingStatus,
} from '../tracking-status.js';

describe('jobStatusToTrackingStatus', () => {
  it('maps every job status to a real tracking status', () => {
    for (const status of JOB_STATUSES as readonly JobStatus[]) {
      const mapped = jobStatusToTrackingStatus(status);
      expect(mapped).toBeDefined();
      expect(TRACKING_STATUSES).toContain(mapped);
    }
  });

  it("calls Moovo's in-transit leg OUT FOR DELIVERY, and that is not a typo", () => {
    // A Moovo courier in transit is minutes from the door, not days from a hub.
    // The tracker's words describe what the RECIPIENT should expect, so mapping
    // this onto `in_transit` would tell somebody to wait while a courier is
    // about to ring the bell.
    expect(jobStatusToTrackingStatus('in_transit')).toBe('out_for_delivery');
    expect(jobStatusToTrackingStatus('picked_up')).toBe('in_transit');
  });

  it('keeps the dispatch auction invisible to the recipient', () => {
    // `requested` and `offered` are Moovo's courier race. A recipient has no
    // use for either, and both mean the same thing to them: nothing yet.
    expect(jobStatusToTrackingStatus('requested')).toBe('pending');
    expect(jobStatusToTrackingStatus('offered')).toBe('pending');
  });

  it('preserves the terminal statuses as terminal', () => {
    expect(isTerminalTrackingStatus(jobStatusToTrackingStatus('delivered'))).toBe(true);
    expect(isTerminalTrackingStatus(jobStatusToTrackingStatus('cancelled'))).toBe(true);
    expect(isTerminalTrackingStatus(jobStatusToTrackingStatus('picked_up'))).toBe(false);
  });
});

describe('TRACKING_TERMINAL_STATUSES', () => {
  it('names only real tracking statuses', () => {
    for (const status of TRACKING_TERMINAL_STATUSES) {
      expect(TRACKING_STATUSES).toContain(status);
    }
  });

  it('includes returned, which is easy to leave out and expensive to poll forever', () => {
    expect(TRACKING_TERMINAL_STATUSES).toContain('returned');
  });
});

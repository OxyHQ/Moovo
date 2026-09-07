/**
 * Moovo's own deliveries inside the tracker, against a real server.
 *
 * The design under test is that a booked job becomes a POINTER and never a
 * copy: one `tracked_parcels` row carrying `moovoJobId`, and **zero
 * checkpoints, for its whole life**. The detail endpoint hydrates the job
 * instead, so the live map and proof of delivery keep working and
 * `job_status_events` keeps exactly one writer.
 *
 * Two things here would fail silently:
 *
 * - **The pointer must commit with the job.** `createJobPointer` refuses the
 *   root connection, because `DatabaseOrTransaction` is a union the root handle
 *   satisfies — so a caller who forgets `tx` type-checks, commits on its own
 *   connection, and leaves a pointer to a job that rolled back.
 * - **The status mirror must cover every status a job can reach.** Asserted by
 *   walking `JOB_TRANSITIONS` rather than spot-checking, because the gap would
 *   appear only for whichever status nobody thought of, and would render as a
 *   blank row in somebody's list.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { getDb } from '../../../db/postgres';
import { createJobPointer, mirrorJobStatus } from '../job-pointer.service.js';
import { jobStatusToTrackingStatus } from '../tracking-status.js';
import { JOB_TRANSITIONS } from '../../job.service.js';
import { findParcelByJobId } from '../../../db/tracking/trackedParcelRepository.js';
import type { JobStatus } from '@moovo/shared-types';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

describeIfPostgres('the Moovo job pointer', () => {
  let suite: SuiteDatabase | null = null;

  async function insertJob(id: string, jobNumber: string) {
    await suite!.client`
      INSERT INTO shipments (
        id, sender_oxy_user_id, type,
        pickup_latitude, pickup_longitude, pickup_line1, pickup_city,
        pickup_postal_code, pickup_country, pickup_contact_name, pickup_contact_phone,
        dropoff_latitude, dropoff_longitude, dropoff_line1, dropoff_city,
        dropoff_postal_code, dropoff_country, dropoff_contact_name, dropoff_contact_phone,
        parcel_weight_kg, parcel_size_class, item_description
      ) VALUES (
        ${`ship-${id}`}, 'oxy-sender', 'package',
        40.4168, -3.7038, 'Calle Mayor 1', 'Madrid', '28013', 'ES', 'Ana', '+34600000000',
        41.3851, 2.1734, 'Carrer Gran 2', 'Barcelona', '08001', 'ES', 'Bea', '+34600000001',
        2.5, 'small', ''
      )
    `;
    await suite!.client`INSERT INTO jobs ${suite!.client({
      id,
      job_number: jobNumber,
      shipment_id: `ship-${id}`,
      sender_oxy_user_id: 'oxy-sender',
      type: 'package',
      fulfillment_type: 'moovo_courier',
      pickup_latitude: 40.4168,
      pickup_longitude: -3.7038,
      pickup_line1: 'Calle Mayor 1',
      pickup_city: 'Madrid',
      pickup_postal_code: '28013',
      pickup_country: 'ES',
      pickup_contact_name: 'Ana',
      pickup_contact_phone: '+34600000000',
      dropoff_latitude: 41.3851,
      dropoff_longitude: 2.1734,
      dropoff_line1: 'Carrer Gran 2',
      dropoff_city: 'Barcelona',
      dropoff_postal_code: '08001',
      dropoff_country: 'ES',
      dropoff_contact_name: 'Bea',
      dropoff_contact_phone: '+34600000001',
      parcel_weight_kg: 2.5,
      parcel_size_class: 'small',
      quote_snapshot: JSON.stringify({ total: { fairMinor: 300 } }),
      totals: JSON.stringify({ total: { fairMinor: 300 } }),
    })}`;
  }

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  beforeEach(async () => {
    await suite!.client`DELETE FROM tracked_parcels`;
    await suite!.client`DELETE FROM jobs`;
    await suite!.client`DELETE FROM shipments`;
  });

  it('ships the moovo carrier with the SCHEMA, not with the boot-time seed', async () => {
    // Booking writes a pointer against this key inside the job's own
    // transaction, so a missing row fails the foreign key — and therefore the
    // BOOKING, not merely the tracker. Leaving it to a boot seed would make
    // that a race between a deploy and its first customer.
    const [row] = await suite!.client<{ key: string }[]>`
      SELECT key FROM tracking_carriers WHERE key = 'moovo'
    `;
    expect(row?.key).toBe('moovo');
  });

  it('creates exactly one pointer with ZERO checkpoints, and subscribes the sender', async () => {
    await insertJob('job-1', 'MOV-000001');
    await getDb().transaction(async (tx) => {
      await createJobPointer(
        {
          jobId: 'job-1',
          jobNumber: 'MOV-000001',
          senderOxyUserId: 'oxy-sender',
          status: 'requested',
        },
        tx,
      );
    });

    const parcel = await findParcelByJobId('job-1');
    expect(parcel).not.toBeNull();
    expect(parcel?.carrierKey).toBe('moovo');
    // The hyphen the job number is printed with cannot survive the CHECK, so
    // the pointer stores what a sender pasting it would normalise to.
    expect(parcel?.trackingNumber).toBe('MOV000001');
    // Never fetched: the job's own timeline is the truth.
    expect(parcel?.pollMode).toBe('manual');
    expect(parcel?.nextPollAt).toBeNull();

    const [checkpoints] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tracking_checkpoints WHERE parcel_id = ${parcel!.id}
    `;
    expect(checkpoints?.count).toBe(0);

    const [subs] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tracked_parcel_subscriptions
      WHERE parcel_id = ${parcel!.id} AND oxy_user_id = 'oxy-sender'
    `;
    expect(subs?.count).toBe(1);
  });

  it('refuses the ROOT connection, so it cannot commit outside the booking', async () => {
    // The guard exists because the type cannot express this: the root handle
    // satisfies `DatabaseOrTransaction`, so forgetting `tx` type-checks and
    // leaves a pointer to a job that rolled back.
    await insertJob('job-2', 'MOV-000002');
    await expect(
      createJobPointer(
        {
          jobId: 'job-2',
          jobNumber: 'MOV-000002',
          senderOxyUserId: 'oxy-sender',
          status: 'requested',
        },
        getDb(),
      ),
    ).rejects.toThrow(/transaction/i);
  });

  it('converges rather than duplicating when a booking is replayed', async () => {
    await insertJob('job-3', 'MOV-000003');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await getDb().transaction(async (tx) => {
        await createJobPointer(
          {
            jobId: 'job-3',
            jobNumber: 'MOV-000003',
            senderOxyUserId: 'oxy-sender',
            status: 'requested',
          },
          tx,
        );
      });
    }
    const [row] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tracked_parcels WHERE moovo_job_id = 'job-3'
    `;
    expect(row?.count).toBe(1);
  });

  it('mirrors EVERY status a job can reach, walked from the transition graph', async () => {
    // Iterated rather than spot-checked: a missing mapping would show as a
    // blank row in a list, and only for whichever status nobody thought of.
    await insertJob('job-4', 'MOV-000004');
    await getDb().transaction(async (tx) => {
      await createJobPointer(
        {
          jobId: 'job-4',
          jobNumber: 'MOV-000004',
          senderOxyUserId: 'oxy-sender',
          status: 'requested',
        },
        tx,
      );
    });

    const reachable = new Set<JobStatus>(['requested']);
    for (const [from, targets] of Object.entries(JOB_TRANSITIONS)) {
      reachable.add(from as JobStatus);
      for (const target of targets) reachable.add(target);
    }

    for (const status of reachable) {
      await mirrorJobStatus('job-4', status);
      const parcel = await findParcelByJobId('job-4');
      expect(parcel?.status).toBe(jobStatusToTrackingStatus(status));
    }
  });

  it('records a delivery time on the pointer when the job is delivered', async () => {
    await insertJob('job-5', 'MOV-000005');
    await getDb().transaction(async (tx) => {
      await createJobPointer(
        {
          jobId: 'job-5',
          jobNumber: 'MOV-000005',
          senderOxyUserId: 'oxy-sender',
          status: 'requested',
        },
        tx,
      );
    });

    await mirrorJobStatus('job-5', 'delivered');
    const parcel = await findParcelByJobId('job-5');
    // The retention window for a watched parcel is measured from the terminal
    // event, so this column is what stops a delivered parcel being kept
    // forever by anything that keeps touching the row.
    expect(parcel?.deliveredAt).not.toBeNull();
  });
});

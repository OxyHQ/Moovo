/**
 * Every statement this service issues against `job_offers`.
 *
 * An offer is dispatch bookkeeping: one time-boxed proposal of one job to one
 * candidate courier. The table has no unique index and needs none — many offers
 * for one job at once is the normal state (a "wave"), and which of them wins is
 * decided by the CAS on `jobs.status`, never here.
 *
 * ## The one place in this port that reads a bare row count
 *
 * {@link expireLapsedOffers} answers "how many offers did this sweep flip". It
 * takes the number off `result.count`, and NOT off the result's `.length`,
 * which is the trap: an UPDATE with no `RETURNING` resolves to an EMPTY array
 * whether it changed a thousand rows or none, so `.length` is a constant zero
 * that reads as careful defensive code. `result.count` is the affected-row
 * count the server actually reported. The same idiom carries
 * `suspendCourier`/`reinstateCourier` in the fleet repository, where the
 * boolean it produces is written into a moderation audit trail.
 *
 * Every other statement here either returns rows (so `.length` is real) or has
 * no caller interested in how many it touched.
 */

import { and, count, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { JobOfferStatus } from '@moovo/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { jobOffers } from '../schema/transport';

/** Offer statuses that are NOT terminal — a courier could still win these. */
export const NON_TERMINAL_OFFER_STATUSES: readonly JobOfferStatus[] = ['offered'];

/** One dispatch offer, as its consumers read it. */
export interface JobOfferRecord {
  id: string;
  jobId: string;
  shipmentId: string;
  courierOxyUserId: string;
  companyId?: string;
  status: JobOfferStatus;
  offeredAt: Date;
  expiresAt: Date;
  rank: number;
  distanceM: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What creating one offer needs. */
export interface NewJobOffer {
  jobId: string;
  shipmentId: string;
  courierOxyUserId: string;
  companyId?: string | undefined;
  offeredAt: Date;
  expiresAt: Date;
  rank: number;
  distanceM: number;
}

type JobOfferRow = typeof jobOffers.$inferSelect;

function toRecord(row: JobOfferRow): JobOfferRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    shipmentId: row.shipmentId,
    courierOxyUserId: row.courierOxyUserId,
    ...(row.companyId === null ? {} : { companyId: row.companyId }),
    status: row.status as JobOfferStatus,
    offeredAt: row.offeredAt,
    expiresAt: row.expiresAt,
    rank: row.rank,
    distanceM: row.distanceM,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Offer one job to one candidate. */
export async function insertJobOffer(
  input: NewJobOffer,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobOfferRecord> {
  const [row] = await db
    .insert(jobOffers)
    .values({
      id: uuidv7(),
      jobId: input.jobId,
      shipmentId: input.shipmentId,
      courierOxyUserId: input.courierOxyUserId,
      companyId: input.companyId ?? null,
      status: 'offered',
      offeredAt: input.offeredAt,
      expiresAt: input.expiresAt,
      rank: input.rank,
      distanceM: input.distanceM,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting a job offer returned no row');
  }
  return toRecord(row);
}

/** The caller's own live offer for a job, which is what gates an accept. */
export async function findLiveOfferForCourier(
  jobId: string,
  courierOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobOfferRecord | null> {
  const [row] = await db
    .select()
    .from(jobOffers)
    .where(
      and(
        eq(jobOffers.jobId, jobId),
        eq(jobOffers.courierOxyUserId, courierOxyUserId),
        eq(jobOffers.status, 'offered'),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * Couriers holding a non-terminal offer for this job.
 *
 * The dispatch exclusion list: a courier is never offered the same job twice in
 * two waves. Selects the one column it needs.
 */
export async function listCourierIdsWithLiveOffer(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ courierOxyUserId: jobOffers.courierOxyUserId })
    .from(jobOffers)
    .where(
      and(
        eq(jobOffers.jobId, jobId),
        /**
         * `inArray`, never a bare array interpolated into a `sql` template: the
         * latter renders a ROW CONSTRUCTOR (`($1, $2)`), which Postgres refuses
         * to compare against a text column — a runtime error `tsc` cannot see.
         */
        inArray(jobOffers.status, [...NON_TERMINAL_OFFER_STATUSES]),
      ),
    );
  return rows.map((row) => row.courierOxyUserId);
}

/** Set one offer's status. */
export async function setOfferStatus(
  offerId: string,
  status: JobOfferStatus,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(jobOffers).set({ status }).where(eq(jobOffers.id, offerId));
}

/**
 * Supersede every still-live offer for a job, optionally sparing one, and
 * report whose offers were taken.
 *
 * `RETURNING` the courier ids rather than reading them first and updating
 * after: the two-statement form can tell a courier their offer was taken when
 * the update then matched nothing, and can miss one that became live in
 * between. One statement makes the notification list exactly the set that was
 * actually superseded.
 */
export async function supersedeLiveOffers(
  jobId: string,
  exceptOfferId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .update(jobOffers)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(jobOffers.jobId, jobId),
        eq(jobOffers.status, 'offered'),
        ...(exceptOfferId ? [ne(jobOffers.id, exceptOfferId)] : []),
      ),
    )
    .returning({ courierOxyUserId: jobOffers.courierOxyUserId });
  return rows.map((row) => row.courierOxyUserId);
}

/**
 * Flip every live offer past its deadline to `expired`, answering how many.
 *
 * The semantic flip that must run BEFORE the expiry sweep's unconditional
 * delete — see `db/expiry.ts`. The count comes off `result.count`; see this
 * module's header for why `.length` cannot be used here.
 */
export async function expireLapsedOffers(
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const result = await db
    .update(jobOffers)
    .set({ status: 'expired' })
    .where(and(eq(jobOffers.status, 'offered'), lt(jobOffers.expiresAt, now)));
  return result.count ?? 0;
}

/** Whether this job has any offer in the given status. */
export async function jobHasOfferInStatus(
  jobId: string,
  status: JobOfferStatus,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(jobOffers)
    .where(and(eq(jobOffers.jobId, jobId), eq(jobOffers.status, status)))
    .limit(1);
  return row !== undefined;
}

/** One courier's offer history, grouped by outcome. */
export interface OfferOutcomeCount {
  status: JobOfferStatus;
  count: number;
}

/**
 * How every offer ever addressed to this courier ended.
 *
 * The port of a `$group` by status with a `$sum: 1`. The hazard is the driver's:
 * postgres.js decodes `int8` as a STRING, and the caller SUMS these across
 * groups — with strings, `0 + "3"` is `"3"` and `"3" + "2"` is `"32"`, an
 * acceptance rate of 0.09 instead of 0.6, silently, and only once a courier has
 * offers in two different terminal statuses.
 *
 * There are TWO layers here and the measurement says either one alone is
 * sufficient, which is worth writing down rather than leaving as folklore.
 * Mutation-tested against this server: respelling `count()` as a raw
 * `` sql`count(*)` `` while keeping the `Number(...)` is GREEN, and dropping the
 * `Number(...)` while keeping `count()` is also GREEN — the suite only reds when
 * BOTH go, which is exactly when the guarantee is actually gone. So neither is
 * redundant belt-and-braces and neither is load-bearing alone; they are two
 * independent defences, and the test's sensitivity is correct.
 */
export async function countOfferOutcomesForCourier(
  courierOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferOutcomeCount[]> {
  const rows = await db
    .select({ status: jobOffers.status, total: count() })
    .from(jobOffers)
    .where(eq(jobOffers.courierOxyUserId, courierOxyUserId))
    .groupBy(jobOffers.status);
  return rows.map((row) => ({
    status: row.status as JobOfferStatus,
    count: Number(row.total),
  }));
}

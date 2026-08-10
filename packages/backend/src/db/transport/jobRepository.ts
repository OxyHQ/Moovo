/**
 * Every statement this service issues against `jobs` and its two child tables.
 *
 * `jobShape.ts` owns the translation between the flat columns and the nested
 * shape consumers read; this module owns the SQL. Three things here are
 * load-bearing and would each "work" on every happy path if they were written
 * the obvious way instead.
 *
 * ## 1. The status CAS reads a ROW, never a count
 *
 * The source was `findOneAndUpdate({_id, status: current}, …, {new: true})` —
 * one statement that both GUARDS on the current status and hands back the new
 * document. `UPDATE … WHERE id = ? AND status = ? RETURNING *` is the same
 * statement, and `.returning()` is what keeps it one: without it the caller
 * would have to re-read, and between the write and the read another transition
 * can land, so the "new" state it reported would be somebody else's.
 *
 * The count trap the rest of this port carries does NOT reach these functions,
 * and the reason is worth stating rather than assumed: with `RETURNING` the
 * driver hands back the actual rows, so an empty array really does mean the
 * predicate matched nothing. It is an UPDATE *without* `RETURNING` whose
 * `.length` is 0 whether or not it applied — see {@link expireLapsedOffers} in
 * `jobOfferRepository.ts`, which is the one place that reads a bare count.
 *
 * ## 2. The status event commits WITH the transition
 *
 * Mongo did `$set` and `$push` in one document update, so a transition that
 * left no audit entry was unrepresentable. Two statements can drift, so both
 * functions below take a transaction and both are called inside one. A job
 * whose status moved with nothing in its trail saying so is not a smaller bug
 * than a failed transition — it is a worse one, because nothing reports it.
 *
 * ## 3. Booking converges without ever failing a statement
 *
 * See {@link insertJobIfAbsent}.
 */

import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { JobStatus } from '@moovo/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { jobLocationPings, jobs, jobStatusEvents } from '../schema/transport';
import {
  toJobColumns,
  toJobRecord,
  toLocationPingValue,
  toStatusEventValue,
  type JobLocationPingValue,
  type JobProofOfDeliveryValue,
  type JobRecord,
  type JobStatusEventValue,
  type JobWithHistory,
  type NewJob,
  type NewJobStatusEvent,
} from './jobShape';

/** Which jobs a list request wants. */
export interface JobListFilter {
  senderOxyUserId?: string;
  courierOxyUserId?: string;
  fulfillmentType?: string;
  status?: JobStatus | undefined;
}

/** Offset pagination, as the source's `skip`/`limit` expressed it. */
export interface JobListPage {
  page: number;
  limit: number;
}

function listPredicate(filter: JobListFilter) {
  return and(
    ...(filter.senderOxyUserId ? [eq(jobs.senderOxyUserId, filter.senderOxyUserId)] : []),
    ...(filter.courierOxyUserId ? [eq(jobs.courierOxyUserId, filter.courierOxyUserId)] : []),
    ...(filter.fulfillmentType ? [eq(jobs.fulfillmentType, filter.fulfillmentType)] : []),
    ...(filter.status ? [eq(jobs.status, filter.status)] : []),
  );
}

/**
 * Insert a booked job, or report that its idempotency key already claimed one.
 *
 * `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
 * which is the port of `{idempotencyKey: 1}, {unique: true, sparse: true}` plus
 * the source's `catch (11000)`. The empty `RETURNING` IS the "somebody else
 * already booked this" answer — there is no error to catch, which is the whole
 * point: the alternative shape (plain INSERT, catch `23505`, read the prior
 * row) needs a SAVEPOINT to survive, because in Postgres one failed statement
 * aborts the whole transaction and the recovery read would fail too. Declining
 * to raise the error is simpler than recovering from it.
 *
 * That trade buys a different trap, so it is pinned rather than trusted: the
 * `WHERE` clause is the PARTIAL INDEX's own predicate, and Postgres needs it to
 * identify the arbiter. Drop it and every booking dies on
 * `42P10 there is no unique or exclusion constraint matching the ON CONFLICT
 * specification` — clean under `tsc`, accepted by any mock, fatal on the first
 * real request. `job-dispatch.realdb.test.ts` mutation-tests exactly that.
 *
 * A conflict on `jobs_job_number_key` is NOT swallowed: naming the arbiter
 * means only that index cancels the insert, and a duplicate job number is a
 * broken sequence rather than a replayed booking.
 *
 * A job with no idempotency key never satisfies the index predicate, so it can
 * raise no conflict here and always returns its row.
 */
export async function insertJobIfAbsent(
  input: NewJob,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord | null> {
  const [row] = await db
    .insert(jobs)
    .values({ id: uuidv7(), ...toJobColumns(input) })
    .onConflictDoNothing({
      target: jobs.idempotencyKey,
      where: sql`${jobs.idempotencyKey} is not null`,
    })
    .returning();
  return row ? toJobRecord(row) : null;
}

/** Append one entry to a job's audit trail. */
export async function insertJobStatusEvent(
  event: NewJobStatusEvent,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(jobStatusEvents).values({
    id: uuidv7(),
    jobId: event.jobId,
    status: event.status,
    at: event.at,
    byOxyUserId: event.byOxyUserId ?? null,
    note: event.note ?? null,
    latitude: event.location ? event.location.coordinates[1] : null,
    longitude: event.location ? event.location.coordinates[0] : null,
  });
}

/** One job by id, without its trails. */
export async function findJobById(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ? toJobRecord(row) : null;
}

/** The prior job a replayed booking converges on. */
export async function findJobByIdempotencyKey(
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? toJobRecord(row) : null;
}

/**
 * A job's audit trail, oldest first.
 *
 * Ordered by `at` with `id` breaking ties, and the tie-break is ONLY that: the
 * ids are uuid v7 and are NOT monotonic within a millisecond, so two events
 * stamped at the same millisecond have no recoverable order. That is a property
 * this table does not have rather than one it gets wrong — the source's array
 * position did carry it, and no column here replaces it. Every writer stamps
 * `at` from its own clock, and two lifecycle transitions inside one millisecond
 * would be two HTTP requests landing in the same tick.
 */
export async function listJobStatusEvents(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobStatusEventValue[]> {
  const rows = await db
    .select()
    .from(jobStatusEvents)
    .where(eq(jobStatusEvents.jobId, jobId))
    .orderBy(asc(jobStatusEvents.at), asc(jobStatusEvents.id));
  return rows.map(toStatusEventValue);
}

/**
 * The most recent `limit` breadcrumbs, oldest first.
 *
 * The source capped the STORED trail with `$push … $slice: -N`, because an
 * unbounded array grows one Mongo document without bound. The table has no such
 * limit and the schema deliberately keeps every ping, so the cap moves to the
 * READ: the newest `limit` rows, reversed, which is byte-identical to what the
 * source's array held. Nothing is destroyed to produce it, so pruning stays a
 * retention decision for whoever owns the trail rather than a side effect of
 * showing it.
 *
 * `desc` then reverse, rather than `asc` with an offset: the offset form needs
 * the total count first and would answer differently the moment a ping lands
 * between the two statements.
 */
export async function listRecentLocationPings(
  jobId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobLocationPingValue[]> {
  const rows = await db
    .select()
    .from(jobLocationPings)
    .where(eq(jobLocationPings.jobId, jobId))
    .orderBy(desc(jobLocationPings.at), desc(jobLocationPings.id))
    .limit(limit);
  return rows.reverse().map(toLocationPingValue);
}

/** A job plus both trails — what a detail view and every action response need. */
export async function findJobWithHistory(
  jobId: string,
  pingLimit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobWithHistory | null> {
  const job = await findJobById(jobId, db);
  if (!job) return null;
  return attachHistory(job, pingLimit, db);
}

/** Load both trails onto a job already read. */
export async function attachHistory(
  job: JobRecord,
  pingLimit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobWithHistory> {
  const [statusHistory, locationPings] = await Promise.all([
    listJobStatusEvents(job.id, db),
    listRecentLocationPings(job.id, pingLimit, db),
  ]);
  return { ...job, statusHistory, locationPings };
}

/**
 * A page of jobs, newest first.
 *
 * `id` breaks ties on `createdAt`, which the source's `{createdAt: -1}` left
 * unbroken — an offset paginator with an unstable order can show a row twice or
 * skip it. `id` makes the order TOTAL and means nothing else; see
 * `listShipmentsForSender`, which carries the same note for the same reason.
 *
 * Deliberately WITHOUT the trails: this feeds `summarizeJobs`, which reads
 * neither, and the type says so.
 */
export async function listJobs(
  filter: JobListFilter,
  { page, limit }: JobListPage,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(listPredicate(filter))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return rows.map(toJobRecord);
}

/**
 * How many jobs match, for the paginated response's `total`.
 *
 * drizzle's `count()` helper, which maps its own result to a number where a raw
 * `` sql`count(*)` `` would hand the response the string postgres.js decodes
 * `int8` as. The `Number(...)` is redundant today and guards the respelling.
 */
export async function countJobs(
  filter: JobListFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(jobs).where(listPredicate(filter));
  return Number(row?.total ?? 0);
}

/** What a status transition writes besides the status itself. */
export interface JobTransitionWrite {
  jobId: string;
  from: JobStatus;
  to: JobStatus;
  proofOfDelivery?: JobProofOfDeliveryValue | undefined;
}

/** The proof-of-delivery columns, as a `set` fragment. */
function proofColumns(proof: JobProofOfDeliveryValue) {
  return {
    podPhotoFileId: proof.photoFileId ?? null,
    podSignatureFileId: proof.signatureFileId ?? null,
    podNote: proof.note ?? null,
    podRecipientName: proof.recipientName ?? null,
    podAt: proof.at,
  };
}

/**
 * Move a job between statuses, guarded on the one it is in.
 *
 * The source's atomic CAS: only the caller whose `from` still matches wins, and
 * a loser is told nothing happened (`null`) rather than being handed a job that
 * somebody else moved. The predicate IS the concurrency control — without it
 * two simultaneous transitions both "succeed" and the second silently
 * overwrites the first, which looks exactly like working software.
 */
export async function casJobStatus(
  write: JobTransitionWrite,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord | null> {
  const [row] = await db
    .update(jobs)
    .set({
      status: write.to,
      ...(write.proofOfDelivery ? proofColumns(write.proofOfDelivery) : {}),
    })
    .where(and(eq(jobs.id, write.jobId), eq(jobs.status, write.from)))
    .returning();
  return row ? toJobRecord(row) : null;
}

/**
 * Take a job for a courier: `offered → accepted` plus the assignment, in ONE
 * statement.
 *
 * The assignment must be in the same UPDATE as the status change, not a second
 * one behind it: the CAS is what makes the first courier the winner, so a
 * separate assignment write could be applied by a loser who read the job
 * between the two.
 */
export async function casJobAccepted(
  jobId: string,
  courierOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord | null> {
  const [row] = await db
    .update(jobs)
    .set({ status: 'accepted', courierOxyUserId })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'offered')))
    .returning();
  return row ? toJobRecord(row) : null;
}

/** Record that a dispatch wave was attempted. */
export async function setDispatchAttempts(
  jobId: string,
  attempts: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(jobs).set({ dispatchAttempts: attempts }).where(eq(jobs.id, jobId));
}

/** Record one courier breadcrumb. */
export async function insertLocationPing(
  jobId: string,
  point: { longitude: number; latitude: number; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(jobLocationPings).values({
    id: uuidv7(),
    jobId,
    latitude: point.latitude,
    longitude: point.longitude,
    at: point.at,
  });
}

/**
 * Every Moovo-courier job still waiting for one.
 *
 * The sweep's candidate set, unbounded exactly as the source's `find` was: it
 * is the set of jobs nobody has taken yet, which is small when dispatch works
 * and is precisely what needs looking at when it does not.
 */
export async function listJobsAwaitingCourier(
  statuses: readonly JobStatus[],
  db: DatabaseOrTransaction = getDb(),
): Promise<JobRecord[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.fulfillmentType, 'moovo_courier'), inArray(jobs.status, [...statuses])),
    );
  return rows.map(toJobRecord);
}

/**
 * Whether the reporter is a party to this job — the sender or its courier.
 *
 * Answers a boolean and selects one constant, because that is the whole of what
 * `report-intake` needs and a job's rows are exactly what must not be loaded
 * into a process assembling a report. The source's `.select('_id')` said the
 * same thing.
 */
export async function isJobParty(
  jobId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        or(eq(jobs.senderOxyUserId, oxyUserId), eq(jobs.courierOxyUserId, oxyUserId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The projection `delivery-context.ts` attaches to a moderation case.
 *
 * A named column list rather than the row, and the omissions are the point:
 * `pickup_code`, `dropoff_code`, both code HASHES and `payment_reference` are
 * never LOADED, so an accidental spread of this object cannot leak a delivery
 * verification code — the field is not on it. The source expressed the same
 * intent as a `.select()` string; the column list is now the projection itself.
 *
 * The endpoint columns that ARE here are the ones `redactEndpoint` reduces to a
 * coarse place label and the user's own note. Contact names and phone numbers
 * are not among them.
 */
export interface JobModerationFacts {
  id: string;
  shipmentId: string;
  senderOxyUserId: string;
  courierOxyUserId?: string;
  type: string;
  fulfillmentType: string;
  status: string;
  pickupCity: string;
  pickupRegion?: string;
  pickupCountry: string;
  pickupNotes?: string;
  dropoffCity: string;
  dropoffRegion?: string;
  dropoffCountry: string;
  dropoffNotes?: string;
  parcelSizeClass: string;
  parcelWeightKg: number;
  parcelPieces: number;
  parcelFragile: boolean;
  proofNote?: string;
  createdAt: Date;
}

export async function findJobModerationFacts(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<JobModerationFacts | null> {
  const [row] = await db
    .select({
      id: jobs.id,
      shipmentId: jobs.shipmentId,
      senderOxyUserId: jobs.senderOxyUserId,
      courierOxyUserId: jobs.courierOxyUserId,
      type: jobs.type,
      fulfillmentType: jobs.fulfillmentType,
      status: jobs.status,
      pickupCity: jobs.pickupCity,
      pickupRegion: jobs.pickupRegion,
      pickupCountry: jobs.pickupCountry,
      pickupNotes: jobs.pickupNotes,
      dropoffCity: jobs.dropoffCity,
      dropoffRegion: jobs.dropoffRegion,
      dropoffCountry: jobs.dropoffCountry,
      dropoffNotes: jobs.dropoffNotes,
      parcelSizeClass: jobs.parcelSizeClass,
      parcelWeightKg: jobs.parcelWeightKg,
      parcelPieces: jobs.parcelPieces,
      parcelFragile: jobs.parcelFragile,
      proofNote: jobs.podNote,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    senderOxyUserId: row.senderOxyUserId,
    ...(row.courierOxyUserId === null ? {} : { courierOxyUserId: row.courierOxyUserId }),
    type: row.type,
    fulfillmentType: row.fulfillmentType,
    status: row.status,
    pickupCity: row.pickupCity,
    ...(row.pickupRegion === null ? {} : { pickupRegion: row.pickupRegion }),
    pickupCountry: row.pickupCountry,
    ...(row.pickupNotes === null ? {} : { pickupNotes: row.pickupNotes }),
    dropoffCity: row.dropoffCity,
    ...(row.dropoffRegion === null ? {} : { dropoffRegion: row.dropoffRegion }),
    dropoffCountry: row.dropoffCountry,
    ...(row.dropoffNotes === null ? {} : { dropoffNotes: row.dropoffNotes }),
    parcelSizeClass: row.parcelSizeClass,
    parcelWeightKg: row.parcelWeightKg,
    parcelPieces: row.parcelPieces,
    parcelFragile: row.parcelFragile,
    ...(row.proofNote === null ? {} : { proofNote: row.proofNote }),
    createdAt: row.createdAt,
  };
}

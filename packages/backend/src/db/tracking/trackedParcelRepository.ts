/**
 * Every statement this service issues against `tracked_parcels`.
 *
 * Two properties in here are load-bearing and silent when broken.
 *
 * **Find-or-create must never RAISE.** Two people adding the same number at the
 * same moment both miss a `SELECT` and both `INSERT`; the second gets `23505`.
 * In Postgres a raised duplicate-key aborts the surrounding transaction, so
 * every later statement fails with `25P02` — and this runs inside one, beside
 * the subscription write. `ON CONFLICT DO NOTHING RETURNING` plus a re-read
 * makes the empty result the answer instead. Same rule, same reason, as the
 * moderation claims.
 *
 * **The lease is the claim; `status` is the PARCEL's.** Unlike
 * `moderation_outboxes` there is no `pending`/`processing` on this row. A
 * parcel that is `delivered` and a parcel that is being fetched right now are
 * facts on different axes, and merging them would make one unreadable.
 */

import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { trackedParcels, trackedParcelSubscriptions } from '../schema/tracking';
import { trackedParcelExpiresAt } from './retention';

/** A `tracked_parcels` row exactly as stored. */
export type TrackedParcelRow = typeof trackedParcels.$inferSelect;

export interface FindOrCreateParcelInput {
  carrierKey: string;
  /** Already through `normalizeTrackingNumber`; the CHECK refuses anything else. */
  trackingNumber: string;
  destinationPostalCode?: string;
  destinationCountry?: string;
  /** Set only for a Moovo job pointer, which also requires `carrierKey === 'moovo'`. */
  moovoJobId?: string;
  pollMode?: string;
  now?: Date;
}

/**
 * The shared identity for one `(carrier, number)`, creating it if absent.
 *
 * Born with `subscriberCount = 0` and `nextPollAt = null`: an anonymous lookup
 * creates the row as a cache and nothing more, so it costs exactly one carrier
 * call and is reaped in thirty days. Subscribing is what arms the poller.
 */
export async function findOrCreateParcel(
  input: FindOrCreateParcelInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ parcel: TrackedParcelRow; created: boolean }> {
  const now = input.now ?? new Date();

  const inserted = await db
    .insert(trackedParcels)
    .values({
      id: uuidv7(),
      carrierKey: input.carrierKey,
      trackingNumber: input.trackingNumber,
      destinationPostalCode: input.destinationPostalCode ?? null,
      destinationCountry: input.destinationCountry ?? null,
      moovoJobId: input.moovoJobId ?? null,
      pollMode: input.pollMode ?? 'poll',
      expiresAt: trackedParcelExpiresAt({ now, subscriberCount: 0, terminalAt: null }),
    })
    // NOT a raise. See the header: a `23505` here would poison a transaction
    // that still has a subscription row to write.
    .onConflictDoNothing({
      target: [trackedParcels.carrierKey, trackedParcels.trackingNumber],
    })
    .returning();

  if (inserted[0]) return { parcel: inserted[0], created: true };

  const existing = await findParcelByNumber(input.carrierKey, input.trackingNumber, db);
  if (!existing) {
    // Only reachable if the row was deleted between the insert and this read —
    // the retention sweep is the one thing that could. Surfacing it is better
    // than a null the caller has to invent a meaning for.
    throw new Error(
      `tracked parcel ${input.carrierKey}/${input.trackingNumber} vanished between insert and read`,
    );
  }
  return { parcel: existing, created: false };
}

export async function findParcelByNumber(
  carrierKey: string,
  trackingNumber: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelRow | null> {
  const [row] = await db
    .select()
    .from(trackedParcels)
    .where(
      and(
        eq(trackedParcels.carrierKey, carrierKey),
        eq(trackedParcels.trackingNumber, trackingNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findParcelById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelRow | null> {
  const [row] = await db.select().from(trackedParcels).where(eq(trackedParcels.id, id)).limit(1);
  return row ?? null;
}

/** The pointer row for a Moovo job, when one exists. */
export async function findParcelByJobId(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelRow | null> {
  const [row] = await db
    .select()
    .from(trackedParcels)
    .where(eq(trackedParcels.moovoJobId, jobId))
    .limit(1);
  return row ?? null;
}

/**
 * Recompute `subscriber_count` from the subscriptions themselves, and return
 * the new value.
 *
 * Counting rather than incrementing, because the counter is advisory and a
 * count cannot drift. Cheap: the index on `(parcel_id)` exists for the
 * notification fan-out and serves this too.
 */
export async function refreshSubscriberCount(
  parcelId: string,
  nextPollAt: Date | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trackedParcelSubscriptions)
    .where(eq(trackedParcelSubscriptions.parcelId, parcelId));
  const count = counted?.count ?? 0;

  const [current] = await db
    .select({ deliveredAt: trackedParcels.deliveredAt })
    .from(trackedParcels)
    .where(eq(trackedParcels.id, parcelId))
    .limit(1);

  await db
    .update(trackedParcels)
    .set({
      subscriberCount: count,
      nextPollAt,
      expiresAt: trackedParcelExpiresAt({
        now: new Date(),
        subscriberCount: count,
        terminalAt: current?.deliveredAt ?? null,
      }),
    })
    .where(eq(trackedParcels.id, parcelId));

  return count;
}

/** What one successful fetch changes on the row. */
export interface ParcelSnapshotUpdate {
  status: string;
  rawStatus?: string | null;
  serviceName?: string | null;
  originCountry?: string | null;
  destinationCountry?: string | null;
  estimatedDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  lastCheckpointAt?: Date | null;
  checkpointCount: number;
  nextPollAt: Date | null;
  pollMode?: string;
  now?: Date;
}

/** Apply a fetch result, clear the failure counters and release the lease. */
export async function applyParcelSnapshot(
  parcelId: string,
  subscriberCount: number,
  update: ParcelSnapshotUpdate,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = update.now ?? new Date();
  await db
    .update(trackedParcels)
    .set({
      status: update.status,
      rawStatus: update.rawStatus ?? null,
      serviceName: update.serviceName ?? null,
      originCountry: update.originCountry ?? null,
      destinationCountry: update.destinationCountry ?? null,
      estimatedDeliveryAt: update.estimatedDeliveryAt ?? null,
      deliveredAt: update.deliveredAt ?? null,
      lastCheckpointAt: update.lastCheckpointAt ?? null,
      checkpointCount: update.checkpointCount,
      nextPollAt: update.nextPollAt,
      ...(update.pollMode ? { pollMode: update.pollMode } : {}),
      lastPolledAt: now,
      consecutiveFailures: 0,
      notFoundStreak: 0,
      lastPollError: null,
      leaseOwner: null,
      leaseUntil: null,
      expiresAt: trackedParcelExpiresAt({
        now,
        subscriberCount,
        terminalAt: update.deliveredAt ?? null,
      }),
    })
    .where(eq(trackedParcels.id, parcelId));
}

/** Move a subscription's parcel: used when a user corrects a wrong carrier. */
export async function markParcelWebhookDriven(
  carrierKey: string,
  trackingNumber: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(trackedParcels)
    .set({ pollMode: 'webhook', nextPollAt: new Date() })
    .where(
      and(
        eq(trackedParcels.carrierKey, carrierKey),
        eq(trackedParcels.trackingNumber, trackingNumber),
      ),
    );
}

/** Parcels whose lease has lapsed or which are due, for the reconciliation pass. */
export async function countDueParcels(db: DatabaseOrTransaction = getDb()): Promise<number> {
  const now = new Date();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trackedParcels)
    .where(
      and(
        lte(trackedParcels.nextPollAt, now),
        or(isNull(trackedParcels.leaseUntil), lte(trackedParcels.leaseUntil, now)),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Claim ONE due parcel for this worker, or return null.
 *
 * The same statement `claimModerationOutboxRow` uses, and for the same reason:
 * `FOR UPDATE SKIP LOCKED` inside the subquery lets every task claim
 * concurrently without any of them blocking or colliding, so the dispatcher can
 * run on every ECS task rather than needing a leader.
 *
 * "Due" means past `next_poll_at` AND unleased (or holding a lease that has
 * lapsed, which is how a dead worker's parcel is reclaimed). Note what is NOT
 * here: any reference to `status`. `status` is the PARCEL's, never the
 * worker's — the lease alone is the claim.
 *
 * `carrierKeys` narrows the claim to carriers that still have budget left this
 * minute. Computed BEFORE claiming rather than claimed-then-released, because
 * releasing would burn a failure count and reorder the queue.
 */
export async function claimDueParcel(
  options: { leaseOwner: string; leaseMs: number; carrierKeys: readonly string[]; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelRow | null> {
  if (options.carrierKeys.length === 0) return null;

  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + options.leaseMs);

  // Built with the drizzle helpers and interpolated, exactly as
  // `claimModerationOutboxRow` does. `inArray` rather than a bare array in the
  // template: interpolating one renders a ROW CONSTRUCTOR, which Postgres
  // rejects at runtime and `tsc` cannot see.
  const due = and(
    isNotNull(trackedParcels.nextPollAt),
    lte(trackedParcels.nextPollAt, now),
    or(isNull(trackedParcels.leaseUntil), lte(trackedParcels.leaseUntil, now)),
    inArray(trackedParcels.carrierKey, [...options.carrierKeys]),
  );

  const [row] = await db
    .update(trackedParcels)
    .set({ leaseOwner: options.leaseOwner, leaseUntil })
    .where(
      sql`${trackedParcels.id} = (
        select ${trackedParcels.id}
        from ${trackedParcels}
        where ${due}
        order by ${trackedParcels.nextPollAt} asc
        for update skip locked
        limit 1
      )`,
    )
    .returning();

  return row ?? null;
}

/** The predicate for "this worker still holds this parcel's lease". */
function ownedLease(parcelId: string, leaseOwner: string, now: Date) {
  return and(
    eq(trackedParcels.id, parcelId),
    eq(trackedParcels.leaseOwner, leaseOwner),
    // `gt`, never a raw template: a `Date` interpolated into `sql` renders as
    // its JS string form, which Postgres refuses to compare against a
    // timestamptz.
    gt(trackedParcels.leaseUntil, now),
  );
}

/**
 * Extend a lease this worker still holds. Returns whether it did.
 *
 * Reads a MATCH count, not a "did anything change" count, and the distinction
 * is the trap `renewModerationOutboxRow` documents: two renewals inside one
 * millisecond compute an IDENTICAL `leaseUntil`, so a renewal that held its
 * lease perfectly modifies no bytes. Spelling this as "something changed" would
 * report a lost lease that was never lost — and the dispatcher answers a lost
 * lease by abandoning work mid-flight.
 *
 * Postgres has one number here and it behaves like `matchedCount`, which is why
 * this ports exactly.
 */
export async function renewParcelLease(
  parcelId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(trackedParcels)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)) })
    .where(ownedLease(parcelId, leaseOwner, now));
  return (result.count ?? 0) === 1;
}

/** Record a failed fetch: back off, keep the error, drop the lease. */
export async function failParcelPoll(
  parcelId: string,
  update: {
    nextPollAt: Date | null;
    lastPollError: string;
    pollMode?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = update.now ?? new Date();
  await db
    .update(trackedParcels)
    .set({
      consecutiveFailures: sql`${trackedParcels.consecutiveFailures} + 1`,
      lastPollError: update.lastPollError.slice(0, 2_000),
      lastPolledAt: now,
      nextPollAt: update.nextPollAt,
      ...(update.pollMode ? { pollMode: update.pollMode } : {}),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(eq(trackedParcels.id, parcelId));
}

/**
 * Record that the carrier says this number does not exist.
 *
 * A separate transition from a failure, and deliberately so: a label created
 * and never scanned is the single most common thing anyone pastes into a
 * tracker. Counted as a failure it would enter error backoff and stay there
 * forever; counted here it expires.
 */
export async function recordParcelNotFound(
  parcelId: string,
  update: { nextPollAt: Date | null; status?: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = update.now ?? new Date();
  await db
    .update(trackedParcels)
    .set({
      notFoundStreak: sql`${trackedParcels.notFoundStreak} + 1`,
      consecutiveFailures: 0,
      lastPollError: null,
      lastPolledAt: now,
      nextPollAt: update.nextPollAt,
      ...(update.status ? { status: update.status } : {}),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(eq(trackedParcels.id, parcelId));
}

/** Drop a lease without recording an outcome — used when a batch is cancelled. */
export async function releaseParcelLease(
  parcelId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(trackedParcels)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(ownedLease(parcelId, leaseOwner, now));
}

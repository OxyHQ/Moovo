/**
 * Every statement this service issues against `tracked_parcel_subscriptions`.
 *
 * This is the table that multiplies per person; `tracked_parcels` is the shared
 * identity it points at. Everything here is scoped by `oxyUserId` IN THE WHERE
 * rather than checked after the read, so there is no path where a row is
 * fetched and the ownership check is forgotten. A miss is a miss, which the
 * caller turns into a 404 — a 403 would confirm that somebody else's parcel
 * exists.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { trackedParcelSubscriptions } from '../schema/tracking';

/** A `tracked_parcel_subscriptions` row exactly as stored. */
export type TrackedParcelSubscriptionRow = typeof trackedParcelSubscriptions.$inferSelect;

export interface SubscribeInput {
  parcelId: string;
  oxyUserId: string;
  /** What the user actually typed, before normalisation. */
  enteredNumber: string;
  title?: string | null;
  notifyOnStateChange?: boolean;
}

/**
 * Subscribe, or return the existing subscription untouched.
 *
 * `DO NOTHING` rather than a raise: adding a parcel you already track is an
 * ordinary double-tap, not an error, and a `23505` here would abort the
 * transaction that also created the parcel.
 */
export async function subscribeIfAbsent(
  input: SubscribeInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ subscription: TrackedParcelSubscriptionRow; created: boolean }> {
  const inserted = await db
    .insert(trackedParcelSubscriptions)
    .values({
      id: uuidv7(),
      parcelId: input.parcelId,
      oxyUserId: input.oxyUserId,
      enteredNumber: input.enteredNumber,
      title: input.title ?? null,
      notifyOnStateChange: input.notifyOnStateChange ?? true,
    })
    .onConflictDoNothing({
      target: [trackedParcelSubscriptions.oxyUserId, trackedParcelSubscriptions.parcelId],
    })
    .returning();

  if (inserted[0]) return { subscription: inserted[0], created: true };

  const existing = await findSubscriptionByParcel(input.oxyUserId, input.parcelId, db);
  if (!existing) {
    throw new Error(`subscription for ${input.oxyUserId}/${input.parcelId} vanished after conflict`);
  }
  return { subscription: existing, created: false };
}

export async function findSubscriptionByParcel(
  oxyUserId: string,
  parcelId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(trackedParcelSubscriptions)
    .where(
      and(
        eq(trackedParcelSubscriptions.oxyUserId, oxyUserId),
        eq(trackedParcelSubscriptions.parcelId, parcelId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One subscription by id, scoped to its owner. */
export async function findSubscriptionForUser(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(trackedParcelSubscriptions)
    .where(
      and(
        eq(trackedParcelSubscriptions.id, id),
        eq(trackedParcelSubscriptions.oxyUserId, oxyUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listSubscriptionsForUser(
  oxyUserId: string,
  options: { includeArchived?: boolean; limit: number; offset: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelSubscriptionRow[]> {
  const where = options.includeArchived
    ? eq(trackedParcelSubscriptions.oxyUserId, oxyUserId)
    : and(
        eq(trackedParcelSubscriptions.oxyUserId, oxyUserId),
        isNull(trackedParcelSubscriptions.archivedAt),
      );

  return await db
    .select()
    .from(trackedParcelSubscriptions)
    .where(where)
    .orderBy(desc(trackedParcelSubscriptions.updatedAt), desc(trackedParcelSubscriptions.id))
    .limit(options.limit)
    .offset(options.offset);
}

/** Everyone watching one parcel, for the notification fan-out. */
export async function listSubscribersOfParcel(
  parcelId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelSubscriptionRow[]> {
  return await db
    .select()
    .from(trackedParcelSubscriptions)
    .where(
      and(
        eq(trackedParcelSubscriptions.parcelId, parcelId),
        isNull(trackedParcelSubscriptions.archivedAt),
      ),
    );
}

export async function updateSubscription(
  id: string,
  oxyUserId: string,
  patch: {
    title?: string | null;
    notifyOnStateChange?: boolean;
    archivedAt?: Date | null;
    lastViewedAt?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackedParcelSubscriptionRow | null> {
  const [row] = await db
    .update(trackedParcelSubscriptions)
    .set(patch)
    .where(
      and(
        eq(trackedParcelSubscriptions.id, id),
        eq(trackedParcelSubscriptions.oxyUserId, oxyUserId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Record that a subscriber has been told about everything up to `at`. */
export async function markNotified(
  id: string,
  at: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(trackedParcelSubscriptions)
    .set({ lastNotifiedCheckpointAt: at })
    .where(eq(trackedParcelSubscriptions.id, id));
}

/** Returns the parcel the subscription pointed at, or null when there was none. */
export async function deleteSubscription(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const [row] = await db
    .delete(trackedParcelSubscriptions)
    .where(
      and(
        eq(trackedParcelSubscriptions.id, id),
        eq(trackedParcelSubscriptions.oxyUserId, oxyUserId),
      ),
    )
    .returning({ parcelId: trackedParcelSubscriptions.parcelId });
  return row?.parcelId ?? null;
}

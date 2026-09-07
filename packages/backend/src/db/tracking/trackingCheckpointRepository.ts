/**
 * Every statement this service issues against `tracking_checkpoints`.
 *
 * **Ingest is idempotent by CONTENT, and it has to be.** Carriers re-send the
 * whole history on every poll — almost none issues a stable event id — so
 * without a content hash this table triples on each cycle and the user's
 * timeline fills with duplicates.
 *
 * `ON CONFLICT DO NOTHING RETURNING`, never a raise: ingest shares a
 * transaction with the parent row's update, and a `23505` would abort every
 * statement after it.
 */

import { asc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { trackingCheckpoints } from '../schema/tracking';

/** A `tracking_checkpoints` row exactly as stored. */
export type TrackingCheckpointRow = typeof trackingCheckpoints.$inferSelect;

export interface CheckpointInsert {
  occurredAt: Date;
  occurredAtIsLocal?: boolean;
  status: string;
  rawStatus?: string | null;
  description?: string | null;
  locationText?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * The identity of a checkpoint, derived from what it SAYS.
 *
 * Deliberately excludes `receivedAt` — when Moovo learned of an event is not
 * part of the event, and including it would make every poll's copy distinct,
 * which is the exact failure the key exists to prevent.
 */
export function checkpointDedupeKey(input: CheckpointInsert): string {
  return createHash('sha256')
    .update(
      [
        input.occurredAt.toISOString(),
        input.rawStatus ?? '',
        input.status,
        input.locationText ?? '',
        input.description ?? '',
      ].join('|'),
    )
    .digest('hex');
}

/**
 * Insert every checkpoint that is not already stored; return the new rows.
 *
 * The result is what the caller uses to decide whether anything is worth
 * notifying about, so "nothing new" has to mean exactly that rather than
 * "nothing was written because it all conflicted".
 */
export async function ingestCheckpoints(
  parcelId: string,
  checkpoints: readonly CheckpointInsert[],
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingCheckpointRow[]> {
  if (checkpoints.length === 0) return [];

  const receivedAt = new Date();
  const seen = new Set<string>();
  const values: (typeof trackingCheckpoints.$inferInsert)[] = [];

  for (const checkpoint of checkpoints) {
    const dedupeKey = checkpointDedupeKey(checkpoint);
    // A carrier can repeat an event inside ONE response, and Postgres refuses
    // an INSERT whose own rows conflict with each other even under
    // `ON CONFLICT DO NOTHING` ("cannot affect row a second time"). De-duping
    // the batch first is what keeps that from being a runtime error rather than
    // a no-op.
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    values.push({
      id: uuidv7(),
      parcelId,
      dedupeKey,
      status: checkpoint.status,
      rawStatus: checkpoint.rawStatus ?? null,
      description: checkpoint.description ?? null,
      locationText: checkpoint.locationText ?? null,
      countryCode: checkpoint.countryCode ?? null,
      latitude: checkpoint.latitude ?? null,
      longitude: checkpoint.longitude ?? null,
      occurredAt: checkpoint.occurredAt,
      occurredAtIsLocal: checkpoint.occurredAtIsLocal ?? false,
      receivedAt,
    });
  }

  return await db
    .insert(trackingCheckpoints)
    .values(values)
    .onConflictDoNothing({
      target: [trackingCheckpoints.parcelId, trackingCheckpoints.dedupeKey],
    })
    .returning();
}

/** A parcel's whole timeline, oldest first — the order it is read in. */
export async function listCheckpoints(
  parcelId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingCheckpointRow[]> {
  return await db
    .select()
    .from(trackingCheckpoints)
    .where(eq(trackingCheckpoints.parcelId, parcelId))
    .orderBy(asc(trackingCheckpoints.occurredAt), asc(trackingCheckpoints.id));
}

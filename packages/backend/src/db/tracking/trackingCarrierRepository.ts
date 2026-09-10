/**
 * Every statement this service issues against `tracking_carriers`.
 *
 * The catalogue is small (tens of rows), read on every lookup and edited by
 * operators rather than by code. That shapes two things:
 *
 *  - **The seed is `ON CONFLICT DO NOTHING`, never `DO UPDATE`**, exactly as
 *    `providerRepository.insertProviderIfAbsent` is and for the same reason. A
 *    `DO UPDATE` would reset `enabled`, `source_kind`, the rate budget and
 *    `deep_link_template` on every boot — and `deep_link_template` is the
 *    column somebody fixes by hand the morning a carrier reorganises its site.
 *    The revert would land hours later with nothing connecting it to the fix.
 *  - **`source_kind` is never written by a deploy after creation.** Whether we
 *    read a carrier's public page is a legal decision about that carrier's
 *    terms; shipping an adapter must not be able to enable it.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { trackingCarriers } from '../schema/tracking';

/** A `tracking_carriers` row exactly as stored. */
export type TrackingCarrierRow = typeof trackingCarriers.$inferSelect;

/** What the boot-time seed offers for one carrier. */
export interface SeedTrackingCarrier {
  key: string;
  name: string;
  sourceKind: string;
  pollSupported: boolean;
  webhookSupported: boolean;
  deepLinkTemplate: string;
  countryCodes: string[];
}

/** The whole enabled catalogue, for the picker and the detector's ranking. */
export async function listEnabledTrackingCarriers(
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingCarrierRow[]> {
  return await db
    .select()
    .from(trackingCarriers)
    .where(eq(trackingCarriers.enabled, true))
    .orderBy(asc(trackingCarriers.name));
}

/** One carrier by key. */
export async function findTrackingCarrierByKey(
  key: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingCarrierRow | null> {
  const [row] = await db
    .select()
    .from(trackingCarriers)
    .where(eq(trackingCarriers.key, key))
    .limit(1);
  return row ?? null;
}

/**
 * Carriers for a set of keys, for the hydration batch.
 *
 * `inArray`, never a bare array interpolated into a `sql` template — that
 * renders a row constructor, which Postgres rejects at runtime and `tsc` cannot
 * see.
 */
export async function findTrackingCarriersByKeys(
  keys: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<TrackingCarrierRow[]> {
  if (keys.length === 0) return [];
  return await db.select().from(trackingCarriers).where(inArray(trackingCarriers.key, [...keys]));
}

/**
 * Create one carrier if its `key` is not already taken. Returns whether it was
 * created.
 *
 * The empty vs one-row `RETURNING` set is the answer — a genuine no-op on a
 * repeat rather than a write of identical values, so a warm boot does not touch
 * the row at all.
 */
export async function insertTrackingCarrierIfAbsent(
  input: SeedTrackingCarrier,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(trackingCarriers)
    .values({
      id: uuidv7(),
      key: input.key,
      name: input.name,
      sourceKind: input.sourceKind,
      pollSupported: input.pollSupported,
      webhookSupported: input.webhookSupported,
      deepLinkTemplate: input.deepLinkTemplate,
      countryCodes: input.countryCodes,
    })
    .onConflictDoNothing({ target: trackingCarriers.key })
    .returning({ id: trackingCarriers.id });

  return inserted.length > 0;
}

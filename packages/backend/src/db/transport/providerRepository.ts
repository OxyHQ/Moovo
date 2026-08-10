/**
 * Every statement this service issues against `providers`.
 *
 * `providers` is the ONLY table in this port that carries production rows —
 * two, written by `seedProviders` at boot. Everything else in
 * `moovo-production` is empty, so this is the one repository whose behaviour a
 * backfill actually has to agree with.
 *
 * Two things here are easy to get subtly wrong and silent when wrong:
 *
 *  - **The seed is `ON CONFLICT DO NOTHING`, never `DO UPDATE`.** The source
 *    uses `$setOnInsert` alone precisely so "a deploy never clobbers operator
 *    edits to `enabled`/`supportedCountries`/`config`". A `DO UPDATE` would
 *    reset every one of those on each boot, and the symptom is an operator's
 *    change reverting itself hours later with nothing in the logs.
 *  - **`supportedTypes` is an ARRAY and the source queries it by CONTAINMENT.**
 *    Mongo's `{supportedTypes: 'package'}` matches a document whose array
 *    contains that value; the Postgres equivalent is `= ANY(...)`, not `=`.
 *    Writing `eq()` compiles, runs, and silently matches nothing — so the quote
 *    fan-out would call no external carrier at all and simply return fewer
 *    quotes, which looks like carriers declining rather than a broken query.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { providers } from '../schema/transport';

/** A `providers` row exactly as stored. */
export type ProviderRow = typeof providers.$inferSelect;

/** What the boot-time seed offers for one carrier. */
export interface SeedProvider {
  key: string;
  name: string;
  enabled: boolean;
  supportedTypes: string[];
  supportedCountries: string[];
  config: Record<string, unknown>;
}

/**
 * Enabled providers that serve this shipment type.
 *
 * `= ANY(supported_types)` is array CONTAINMENT — the port of Mongo's
 * `{supportedTypes: <one value>}`, which matches when the stored array holds
 * it. `eq()` would compare the whole array to a scalar and match nothing.
 */
export async function listEnabledProvidersForType(
  shipmentType: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProviderRow[]> {
  return await db
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.enabled, true),
        sql`${shipmentType} = any(${providers.supportedTypes})`,
      ),
    );
}

/** One provider by id, for resolving a quote's carrier at booking time. */
export async function findProviderById(
  providerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProviderRow | null> {
  const [row] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  return row ?? null;
}

/**
 * Providers for a set of ids, for the hydration batch.
 *
 * `inArray`, never a bare array interpolated into a `sql` template — that
 * renders a ROW CONSTRUCTOR, which Postgres rejects at runtime and `tsc`
 * cannot see. Empty in, empty out: `inArray` with no values builds a predicate
 * that is false rather than one that matches everything, but the caller is
 * spared a pointless round trip.
 */
export async function findProvidersByIds(
  providerIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ProviderRow[]> {
  if (providerIds.length === 0) return [];
  return await db.select().from(providers).where(inArray(providers.id, [...providerIds]));
}

/**
 * Create one provider if its `key` is not already taken. Returns whether it
 * was created.
 *
 * `DO NOTHING`, matching the source's `$setOnInsert`-only upsert: an existing
 * provider is left EXACTLY as it stands, including operator edits to
 * `enabled`, `supportedCountries` and `config`. The empty vs one-row
 * `RETURNING` set is the "was it created" answer, the same shape the moderation
 * outbox uses — and it is a genuine no-op on a repeat, not a write of identical
 * values, so a warm boot does not touch the row at all.
 */
export async function insertProviderIfAbsent(
  input: SeedProvider,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(providers)
    .values({
      id: uuidv7(),
      key: input.key,
      name: input.name,
      enabled: input.enabled,
      supportedTypes: input.supportedTypes,
      supportedCountries: input.supportedCountries,
      config: input.config,
    })
    .onConflictDoNothing({ target: providers.key })
    .returning({ id: providers.id });

  return inserted.length > 0;
}

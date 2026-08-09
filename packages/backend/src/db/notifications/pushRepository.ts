/**
 * Every statement against the two push-delivery registries.
 *
 * ## The upserts preserve absence, which `ON CONFLICT DO UPDATE` does not
 *
 * The source builds its `$set` conditionally — `...(input.deviceId ? {deviceId}
 * : {})` — so an upsert that omits `deviceId` leaves whatever was already
 * stored. The obvious translation, `DO UPDATE SET device_id = EXCLUDED.
 * device_id`, does the opposite: it writes the NULL that was not sent and wipes
 * the value. `coalesce(EXCLUDED.x, push_tokens.x)` is what keeps the source's
 * behaviour, and it matters — the field it silently erases is the one that
 * identifies which of a user's devices a token belongs to.
 *
 * ## These deactivations read `matchedCount`, NOT `modifiedCount`
 *
 * The opposite of `dismissNotificationById` next door, and deliberately so.
 * `removePushToken` throws NOT_FOUND on `matchedCount === 0`, so deactivating
 * an ALREADY-inactive token succeeds today. Postgres `rowCount` behaves like
 * `matchedCount`, so a plain predicate is the faithful port — adding
 * `active = true` to it would start 404ing a repeated logout.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { sqlColumnName, uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { pushTokens, webPushSubscriptions } from '../schema/engagement';

export type PushTokenRow = typeof pushTokens.$inferSelect;
export type WebPushSubscriptionRow = typeof webPushSubscriptions.$inferSelect;

// ── Expo push tokens ───────────────────────────────────────────────

/** Whether the user has any ACTIVE Expo push token — the channel-resolution probe. */
export async function hasActivePushToken(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)))
    // `exists`, not a count: the caller only asks whether there is at least
    // one, and counting every token of a user with many devices is work whose
    // result is thrown away.
    .limit(1);
  return rows.length > 0;
}

/** Every active token for the user, for the fan-out. */
export async function listActivePushTokens(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PushTokenRow[]> {
  return await db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)));
}

/** Deactivate one token by row id (a malformed token found during fan-out). */
export async function deactivatePushTokenById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(pushTokens).set({ active: false }).where(eq(pushTokens.id, id));
}

/**
 * Deactivate every row carrying this token value, across users.
 *
 * Scoped by TOKEN alone, exactly as the source is: Expo reporting
 * `DeviceNotRegistered` is a fact about the device, not about one user's
 * registration of it, and the same token can legitimately appear under two
 * users after a device changes hands.
 */
export async function deactivatePushTokenByValue(
  token: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(pushTokens).set({ active: false }).where(eq(pushTokens.token, token));
}

/** Stamp `lastUsedAt` on the tokens a successful send used. */
export async function touchPushTokens(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(pushTokens)
    .set({ lastUsedAt: new Date() })
    // `inArray`, never a bare array interpolated into a `sql` template: that
    // renders a ROW CONSTRUCTOR, which Postgres rejects at runtime and `tsc`
    // cannot see.
    .where(inArray(pushTokens.id, [...ids]));
}

/** Register or reactivate a token, keyed on `(oxyUserId, token)`. */
export async function upsertPushToken(
  input: {
    oxyUserId: string;
    token: string;
    deviceId?: string | undefined;
    platform?: string | undefined;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PushTokenRow> {
  const [row] = await db
    .insert(pushTokens)
    .values({
      id: uuidv7(),
      oxyUserId: input.oxyUserId,
      token: input.token,
      deviceId: input.deviceId ?? null,
      platform: input.platform ?? null,
      active: true,
    })
    .onConflictDoUpdate({
      target: [pushTokens.oxyUserId, pushTokens.token],
      set: {
        active: true,
        // `coalesce`, so an upsert that does not carry a deviceId/platform
        // leaves the stored one alone — the source omits the key entirely
        // rather than sending null, and `EXCLUDED.x` alone would erase it.
        //
        // `sqlColumnName`, never `column.name`: the latter is the drizzle
        // PROPERTY name (`deviceId`), and `excluded.deviceId` is a column that
        // does not exist. The casing authority is what maps it to `device_id`,
        // and `excluded.*` is the one place a query has to spell a column out
        // rather than interpolate the drizzle object. Caught by the real
        // server (42703); nothing in `tsc` or a mocked insert can see it.
        deviceId: sql`coalesce(excluded.${sql.raw(sqlColumnName(pushTokens.deviceId))}, ${pushTokens.deviceId})`,
        platform: sql`coalesce(excluded.${sql.raw(sqlColumnName(pushTokens.platform))}, ${pushTokens.platform})`,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (row === undefined) {
    throw new Error('Upserting a push token returned no row.');
  }
  return row;
}

/**
 * Deactivate one of the user's tokens. Returns whether the pair existed.
 *
 * `matchedCount` semantics — no `active = true` predicate. See the file header.
 */
export async function deactivatePushTokenForUser(
  oxyUserId: string,
  token: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(pushTokens)
    .set({ active: false })
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.token, token)));
  return (result.count ?? 0) > 0;
}

// ── Web push subscriptions ─────────────────────────────────────────

/** Whether the user has any ACTIVE browser subscription. */
export async function hasActiveWebPushSubscription(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: webPushSubscriptions.id })
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Every active subscription for the user, for the fan-out. */
export async function listActiveWebPushSubscriptions(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<WebPushSubscriptionRow[]> {
  return await db
    .select()
    .from(webPushSubscriptions)
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.active, true),
      ),
    );
}

/** Deactivate one subscription by row id (the provider answered 410/404). */
export async function deactivateWebPushSubscriptionById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(webPushSubscriptions)
    .set({ active: false })
    .where(eq(webPushSubscriptions.id, id));
}

/** Register or refresh a subscription, keyed on `(oxyUserId, endpoint)`. */
export async function upsertWebPushSubscription(
  input: { oxyUserId: string; endpoint: string; keyP256dh: string; keyAuth: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<WebPushSubscriptionRow> {
  const [row] = await db
    .insert(webPushSubscriptions)
    .values({
      id: uuidv7(),
      oxyUserId: input.oxyUserId,
      endpoint: input.endpoint,
      keyP256dh: input.keyP256dh,
      keyAuth: input.keyAuth,
      active: true,
    })
    .onConflictDoUpdate({
      target: [webPushSubscriptions.oxyUserId, webPushSubscriptions.endpoint],
      // Both keys are REQUIRED in the source and always sent, so these
      // overwrite unconditionally — a re-registered endpoint really does carry
      // freshly rotated keys, and coalescing them would keep stale ones that
      // no longer decrypt.
      set: {
        active: true,
        keyP256dh: input.keyP256dh,
        keyAuth: input.keyAuth,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (row === undefined) {
    throw new Error('Upserting a web push subscription returned no row.');
  }
  return row;
}

/** Deactivate one of the user's subscriptions. `matchedCount` semantics. */
export async function deactivateWebPushSubscriptionForUser(
  oxyUserId: string,
  endpoint: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(webPushSubscriptions)
    .set({ active: false })
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.endpoint, endpoint),
      ),
    );
  return (result.count ?? 0) > 0;
}

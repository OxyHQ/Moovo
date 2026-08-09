/**
 * The notification domain against a REAL Postgres server.
 *
 * The port's hard part here is not the queries — it is that Mongo reports
 * `modifiedCount` AND `matchedCount`, this domain's callers deliberately use
 * DIFFERENT ones, and Postgres reports only `rowCount`, which behaves like
 * `matchedCount`. So every `modifiedCount` caller needs its "did this actually
 * change anything" condition moved into the WHERE clause, and every
 * `matchedCount` caller must NOT get one.
 *
 * Both mistakes are silent and they fail in OPPOSITE directions, which is why
 * both are pinned here by a REPEATED call — a single call gives the same answer
 * under either semantics, so a test that acts once cannot tell them apart:
 *
 *  - dismiss twice: the second must report false (→ 404), as it does today.
 *  - deactivate a token twice: the second must still succeed (no 404).
 *
 * The upserts get the same treatment. `ON CONFLICT DO UPDATE SET x =
 * EXCLUDED.x` writes the NULL that was not sent, wiping a stored value the
 * source's conditional `$set` preserved — visible only on a SECOND upsert that
 * omits the field.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/testDatabase';
import {
  countNotificationsForUser,
  countUnreadForUser,
  dismissNotificationById,
  insertNotification,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../db/notifications/notificationRepository';
import {
  deactivatePushTokenForUser,
  deactivateWebPushSubscriptionForUser,
  hasActivePushToken,
  listActivePushTokens,
  upsertPushToken,
  upsertWebPushSubscription,
} from '../../db/notifications/pushRepository';
import { listNotifications } from '../notification-read.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

/** A distinct user per case, so no test depends on another's rows. */
const user = (label: string): string => `${label}-${uuidv7()}`;

async function seed(oxyUserId: string, overrides: Record<string, unknown> = {}) {
  return await insertNotification({
    oxyUserId,
    type: 'job_offered',
    title: 'A job is available',
    body: 'Near you',
    channels: ['in_app'],
    deliveryStatus: { in_app: 'pending' },
    status: 'sent',
    priority: 'normal',
    ...overrides,
  });
}

describeIfPostgres('notifications on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  it('dismissing TWICE reports false the second time, as the source does', async () => {
    // `dismissNotification` returns `modifiedCount > 0` and sets only `status`,
    // so a repeat changed nothing and reported false — which the service turns
    // into a 404. Postgres `rowCount` would report 1 for the repeat, so the
    // predicate `status <> 'dismissed'` is what preserves the behaviour.
    const owner = user('dismiss');
    const row = await seed(owner);

    expect(await dismissNotificationById(row.id, owner)).toBe(true);
    expect(await dismissNotificationById(row.id, owner)).toBe(false);
  });

  it('marking read TWICE still reports true, because readAt always moves', async () => {
    // The mirror image, and the reason `markNotificationRead` must NOT carry a
    // `status <> 'read'` predicate: the source sets a fresh `readAt` on every
    // call, so a matched row always changed and re-reading was never a 404.
    const owner = user('read');
    const row = await seed(owner);

    expect(await markNotificationRead(row.id, owner)).toBe(true);
    expect(await markNotificationRead(row.id, owner)).toBe(true);
  });

  it('scopes read/dismiss to the owner', async () => {
    const owner = user('owner');
    const row = await seed(owner);

    expect(await markNotificationRead(row.id, user('stranger'))).toBe(false);
    expect(await dismissNotificationById(row.id, user('stranger'))).toBe(false);
  });

  it('counts unread as a NUMBER and moves them all at once', async () => {
    const owner = user('unread');
    await seed(owner, { status: 'pending' });
    await seed(owner, { status: 'sent' });
    await seed(owner, { status: 'read' });
    await seed(owner, { status: 'dismissed' });

    const unread = await countUnreadForUser(owner);
    // `count(*)` is bigint, which postgres.js decodes as a STRING; drizzle's
    // `count()` only escapes that via `.mapWith(Number)`.
    expect(typeof unread).toBe('number');
    expect(unread).toBe(2);
    expect(unread + 1).toBe(3);

    // Only pending/sent move, and `read`/`dismissed` are left alone.
    expect(await markAllNotificationsRead(owner)).toBe(2);
    expect(await countUnreadForUser(owner)).toBe(0);
    expect(await countNotificationsForUser(owner, { status: 'dismissed' })).toBe(1);
  });

  it('applies the SAME filter to the page and its total', async () => {
    const owner = user('filter');
    await seed(owner, { type: 'job_offered' });
    await seed(owner, { type: 'job_accepted' });
    await seed(owner, { type: 'job_accepted' });

    const filter = { type: 'job_accepted' };
    const rows = await listNotificationsForUser(owner, filter, { limit: 50, offset: 0 });
    expect(rows).toHaveLength(2);
    expect(await countNotificationsForUser(owner, filter)).toBe(2);
    // The unfiltered total must NOT leak into a filtered read.
    expect(await countNotificationsForUser(owner, {})).toBe(3);
  });

  it('OMITS data, conversationId and readAt when unset', async () => {
    const owner = user('dto');
    await seed(owner);

    const { data } = await listNotifications(owner, { page: 1, limit: 10 });
    const json = JSON.parse(JSON.stringify(data[0])) as Record<string, unknown>;
    // Serialized JSON, because `toEqual` ignores explicitly-undefined keys and
    // so cannot tell "absent" from "null" — which is the whole regression.
    expect('data' in json).toBe(false);
    expect('conversationId' in json).toBe(false);
    expect('readAt' in json).toBe(false);
  });

  it('keeps a push token deactivatable TWICE — matchedCount, not modifiedCount', async () => {
    // The opposite convention to `dismiss` above. `removePushToken` throws
    // NOT_FOUND on `matchedCount === 0`, so deactivating an already-inactive
    // token succeeds today and a repeated logout must not start 404ing.
    const owner = user('token');
    await upsertPushToken({ oxyUserId: owner, token: 'ExponentPushToken[abc]' });

    expect(await deactivatePushTokenForUser(owner, 'ExponentPushToken[abc]')).toBe(true);
    expect(await deactivatePushTokenForUser(owner, 'ExponentPushToken[abc]')).toBe(true);
    // And a token that never existed is still false, or the 404 would be dead.
    expect(await deactivatePushTokenForUser(owner, 'ExponentPushToken[never]')).toBe(false);
  });

  it('a second upsert without deviceId PRESERVES the stored one', async () => {
    // The `EXCLUDED.x` trap. The source builds its `$set` conditionally, so an
    // upsert that omits `deviceId` leaves the stored value; `SET device_id =
    // EXCLUDED.device_id` would write the NULL that was not sent. Only a
    // SECOND upsert can show the difference.
    const owner = user('upsert');
    const token = 'ExponentPushToken[keep]';

    const first = await upsertPushToken({
      oxyUserId: owner,
      token,
      deviceId: 'pixel-9',
      platform: 'android',
    });
    expect(first.deviceId).toBe('pixel-9');

    const second = await upsertPushToken({ oxyUserId: owner, token });
    expect(second.id).toBe(first.id);
    expect(second.deviceId).toBe('pixel-9');
    expect(second.platform).toBe('android');
    expect(second.active).toBe(true);

    // One row, not two — the unique index is the whole point of an upsert.
    expect(await listActivePushTokens(owner)).toHaveLength(1);
  });

  it('a re-registered web push subscription REPLACES its keys', async () => {
    // The opposite of the token case, and deliberately: both keys are required
    // and always sent, so a re-registration really does carry rotated keys.
    // Coalescing them would keep stale ones that no longer decrypt.
    const owner = user('webpush');
    const endpoint = 'https://push.example/abc';

    const first = await upsertWebPushSubscription({
      oxyUserId: owner,
      endpoint,
      keyP256dh: 'old-p256dh',
      keyAuth: 'old-auth',
    });
    const second = await upsertWebPushSubscription({
      oxyUserId: owner,
      endpoint,
      keyP256dh: 'new-p256dh',
      keyAuth: 'new-auth',
    });

    expect(second.id).toBe(first.id);
    expect(second.keyP256dh).toBe('new-p256dh');
    expect(second.keyAuth).toBe('new-auth');

    expect(await deactivateWebPushSubscriptionForUser(owner, endpoint)).toBe(true);
    expect(await deactivateWebPushSubscriptionForUser(owner, 'https://push.example/nope')).toBe(
      false,
    );
  });

  it('reports an active push token only while one is active', async () => {
    const owner = user('probe');
    expect(await hasActivePushToken(owner)).toBe(false);

    await upsertPushToken({ oxyUserId: owner, token: 'ExponentPushToken[probe]' });
    expect(await hasActivePushToken(owner)).toBe(true);

    await deactivatePushTokenForUser(owner, 'ExponentPushToken[probe]');
    // The channel resolver reads this to decide whether to add `push`; a probe
    // that ignored `active` would keep sending to a device that logged out.
    expect(await hasActivePushToken(owner)).toBe(false);
  });

  it('refuses an unknown type, status and priority at the DATABASE', async () => {
    const owner = user('checks');
    await expect(seed(owner, { type: 'not-a-type' })).rejects.toThrow();
    await expect(seed(owner, { status: 'not-a-status' })).rejects.toThrow();
    await expect(seed(owner, { priority: 'not-a-priority' })).rejects.toThrow();
    await expect(seed(owner, { channels: ['not-a-channel'] })).rejects.toThrow();
  });
});

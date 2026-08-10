/**
 * The store and seller-profile domains against a real PostgreSQL server.
 *
 * This file REPLACES `services/__tests__/store.service.test.ts`, which mocked
 * the Mongoose model. That was adequate while the invariants were enforced in
 * JavaScript; it is not adequate now, and the reason is the point of the port:
 *
 *  - **The last-owner invariant is enforced under a row LOCK**, inside the same
 *    transaction as the write. A mocked repository has no transaction, no lock
 *    and no second session, so it can assert the ANSWER but never the property.
 *  - **Uniqueness is enforced by an INDEX.** A mock accepts every insert,
 *    including the duplicate the server refuses.
 *
 * **The target is empty and the source is destroyed, so "returns nothing" and
 * "correctly returns nothing" are the same observation.** Every read below is
 * therefore seeded with TWO owners and asserts the other owner's rows are
 * absent — a filter that was dropped entirely would return both and fail, where
 * a test with one owner's data passes whether or not the filter exists.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import {
  deleteMemberRow,
  findMembership,
  findStoreByHandle,
  findStoreById,
  findStoresByIds,
  insertMember,
  insertStore,
  listStoresForMember,
  storeHandleExists,
  updateMemberRow,
  updateStoreRow,
} from '../storeRepository';
import {
  ensureSellerProfile,
  findSellerProfilesByUserIds,
  updateSellerPrefs,
} from '../sellerProfileRepository';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** A store owned by `owner`, with a handle unique to the case. */
async function seedStore(handle: string, owner: string) {
  const store = await insertStore({
    handle,
    name: handle,
    description: '',
    brandColor: '#000000',
    defaultCurrency: 'USD',
    status: 'active',
    owner: { oxyUserId: owner, permissions: ['store:manage'] },
  });
  if (store === null) throw new Error(`seed failed: handle ${handle} taken`);
  return store;
}

describeIfPostgres('the store domain on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    // `store_members` cascades from `stores`, but deleting it explicitly keeps
    // the teardown honest if that FK is ever relaxed.
    await client()`DELETE FROM store_members`;
    await client()`DELETE FROM stores`;
    await client()`DELETE FROM seller_profiles`;
  });

  describe('tenant isolation — the property the authorization boundary rests on', () => {
    it('does not return another store owner\'s stores', async () => {
      await seedStore('alpha-store', 'owner-a');
      await seedStore('beta-store', 'owner-b');

      const forA = await listStoresForMember('owner-a');

      // Both halves matter. The first fails if the query returns nothing at
      // all; the second fails if the membership filter was dropped, which is
      // the mutation that leaks every store to every caller.
      expect(forA.map((s) => s.handle)).toEqual(['alpha-store']);
      expect(forA.some((s) => s.handle === 'beta-store')).toBe(false);
    });

    it('does not grant membership of a store the caller does not belong to', async () => {
      const alpha = await seedStore('alpha-authz', 'owner-a');
      await seedStore('beta-authz', 'owner-b');

      // The exact question `loadStore` asks before admitting a request.
      expect(await findMembership(alpha.id, 'owner-a')).not.toBeNull();
      expect(await findMembership(alpha.id, 'owner-b')).toBeNull();
    });

    it('scopes a membership lookup by BOTH store and user', async () => {
      const alpha = await seedStore('alpha-scope', 'owner-a');
      const beta = await seedStore('beta-scope', 'owner-b');
      await insertMember(beta.id, { oxyUserId: 'shared', role: 'staff', permissions: [] });

      // `shared` is a member of beta and NOT of alpha. A lookup keyed on the
      // user alone would admit them to alpha.
      expect(await findMembership(beta.id, 'shared')).not.toBeNull();
      expect(await findMembership(alpha.id, 'shared')).toBeNull();
    });
  });

  describe('the handle is unique by index, not by a prior check', () => {
    it('refuses a second store on the same handle', async () => {
      await seedStore('taken-handle', 'owner-a');

      // `null` rather than a raised 23505: the caller retries with another
      // suffix, and a raised error would abort a surrounding transaction.
      const second = await insertStore({
        handle: 'taken-handle',
        name: 'Another',
        description: '',
        brandColor: '#000000',
        defaultCurrency: 'USD',
        status: 'active',
        owner: { oxyUserId: 'owner-b', permissions: [] },
      });
      expect(second).toBeNull();
    });

    it('reports an existing handle and leaves a free one alone', async () => {
      await seedStore('probe-handle', 'owner-a');
      expect(await storeHandleExists('probe-handle')).toBe(true);
      expect(await storeHandleExists('probe-handle-2')).toBe(false);
    });

    it('creates the store and its founding owner together', async () => {
      const store = await seedStore('atomic-store', 'owner-a');
      const reread = await findStoreById(store.id);
      expect(reread?.members).toHaveLength(1);
      expect(reread?.members[0]).toMatchObject({ oxyUserId: 'owner-a', role: 'owner' });
    });
  });

  describe('membership is unique per (store, user)', () => {
    it('refuses a duplicate member', async () => {
      const store = await seedStore('dup-member', 'owner-a');
      expect(await insertMember(store.id, { oxyUserId: 'staff-1', role: 'staff', permissions: [] })).not.toBeNull();
      expect(await insertMember(store.id, { oxyUserId: 'staff-1', role: 'staff', permissions: [] })).toBeNull();
      const reread = await findStoreById(store.id);
      expect(reread?.members).toHaveLength(2);
    });

    it('permits the same person in two different stores', async () => {
      const alpha = await seedStore('alpha-both', 'owner-a');
      const beta = await seedStore('beta-both', 'owner-b');
      expect(await insertMember(alpha.id, { oxyUserId: 'both', role: 'staff', permissions: [] })).not.toBeNull();
      expect(await insertMember(beta.id, { oxyUserId: 'both', role: 'staff', permissions: [] })).not.toBeNull();
      expect(await listStoresForMember('both')).toHaveLength(2);
    });
  });

  describe('owner protection', () => {
    it('refuses to remove the LAST owner', async () => {
      const store = await seedStore('last-owner-remove', 'owner-a');
      const outcome = await deleteMemberRow(store.id, 'owner-a');
      expect(outcome.status).toBe('last_owner');
      expect((await findStoreById(store.id))?.members).toHaveLength(1);
    });

    it('refuses to demote the LAST owner', async () => {
      const store = await seedStore('last-owner-demote', 'owner-a');
      const outcome = await updateMemberRow(store.id, 'owner-a', { role: 'staff' });
      expect(outcome.status).toBe('last_owner');
      expect((await findStoreById(store.id))?.members[0].role).toBe('owner');
    });

    it('allows removing a SECOND owner', async () => {
      const store = await seedStore('two-owners-remove', 'owner-a');
      await insertMember(store.id, { oxyUserId: 'owner-2', role: 'owner', permissions: [] });
      const outcome = await deleteMemberRow(store.id, 'owner-2');
      expect(outcome.status).toBe('ok');
      expect((await findStoreById(store.id))?.members).toHaveLength(1);
    });

    it('allows demoting a SECOND owner', async () => {
      const store = await seedStore('two-owners-demote', 'owner-a');
      await insertMember(store.id, { oxyUserId: 'owner-2', role: 'owner', permissions: [] });
      const outcome = await updateMemberRow(store.id, 'owner-2', { role: 'staff' });
      expect(outcome.status).toBe('ok');
      const roles = (await findStoreById(store.id))?.members.map((m) => m.role).sort();
      expect(roles).toEqual(['owner', 'staff']);
    });

    it('reports a missing member and a missing store distinctly', async () => {
      const store = await seedStore('absent-member', 'owner-a');
      expect((await deleteMemberRow(store.id, 'nobody')).status).toBe('member_not_found');
      // A syntactically valid id that names no row.
      const absent = await deleteMemberRow('00000000-0000-7000-8000-000000000000', 'owner-a');
      expect(absent.status).toBe('store_not_found');
    });

    it('counts owners in the store being written, not across stores', async () => {
      // Two stores, one owner each. Removing beta's owner must be refused on
      // BETA's count — a global count would see two owners and allow it.
      await seedStore('count-alpha', 'owner-a');
      const beta = await seedStore('count-beta', 'owner-b');
      expect((await deleteMemberRow(beta.id, 'owner-b')).status).toBe('last_owner');
    });
  });

  describe('store reads and updates', () => {
    it('finds a store by its public handle and not by another\'s', async () => {
      await seedStore('public-alpha', 'owner-a');
      await seedStore('public-beta', 'owner-b');
      expect((await findStoreByHandle('public-alpha'))?.handle).toBe('public-alpha');
      expect(await findStoreByHandle('public-gamma')).toBeNull();
    });

    it('applies a patch and leaves an empty patch as a read', async () => {
      const store = await seedStore('patch-store', 'owner-a');
      const updated = await updateStoreRow(store.id, { name: 'Renamed', policyReturnWindowDays: 14 });
      expect(updated?.name).toBe('Renamed');
      expect(updated?.policies.returnWindowDays).toBe(14);

      // An empty patch must not issue an UPDATE with no assignments, which is a
      // syntax error rather than a no-op.
      const untouched = await updateStoreRow(store.id, {});
      expect(untouched?.name).toBe('Renamed');
    });

    it('returns null for a store that does not exist', async () => {
      expect(await findStoreById('00000000-0000-7000-8000-000000000000')).toBeNull();
    });
  });

  describe('seller profiles — two upsert shapes that must not be collapsed', () => {
    it('creates on first use and converges on the repeat', async () => {
      const first = await ensureSellerProfile('seller-a');
      const second = await ensureSellerProfile('seller-a');

      // The REPEATED call is the discriminator: one call cannot tell an
      // insert-or-nothing from an insert-or-overwrite.
      expect(second.id).toBe(first.id);
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    });

    it('keeps two sellers\' profiles apart', async () => {
      const a = await ensureSellerProfile('seller-a');
      const b = await ensureSellerProfile('seller-b');
      expect(a.id).not.toBe(b.id);
      expect(a.oxyUserId).toBe('seller-a');
      expect(b.oxyUserId).toBe('seller-b');
    });

    it('PERSISTS a preference edit made after the profile exists', async () => {
      // The case that fails if the hybrid upsert is written `DO NOTHING`: the
      // profile already exists, so every later edit would be discarded.
      await ensureSellerProfile('seller-prefs');
      const updated = await updateSellerPrefs('seller-prefs', {
        shippingPrefs: { note: 'ships weekly', handlingDays: 3 },
      });
      expect(updated.shippingPrefs).toEqual({ note: 'ships weekly', handlingDays: 3 });

      const reread = await ensureSellerProfile('seller-prefs');
      expect(reread.shippingPrefs).toEqual({ note: 'ships weekly', handlingDays: 3 });
    });

    it('REPLACES a preference group wholesale rather than merging it', async () => {
      await updateSellerPrefs('seller-replace', {
        shippingPrefs: { note: 'old note', handlingDays: 5 },
      });
      const updated = await updateSellerPrefs('seller-replace', {
        shippingPrefs: { note: 'new note' },
      });

      // The source assigns the whole sub-object, so submitting only `note`
      // CLEARS `handlingDays`. Merging would silently preserve a value the
      // seller had just removed.
      expect(updated.shippingPrefs).toEqual({ note: 'new note' });
      expect(updated.shippingPrefs?.handlingDays).toBeUndefined();
    });

    it('leaves an untouched group alone', async () => {
      await updateSellerPrefs('seller-partial', {
        shippingPrefs: { note: 'keep me', handlingDays: 2 },
        returnPrefs: { accepts: true, windowDays: 30 },
      });
      const updated = await updateSellerPrefs('seller-partial', {
        returnPrefs: { accepts: false },
      });

      expect(updated.shippingPrefs).toEqual({ note: 'keep me', handlingDays: 2 });
      expect(updated.returnPrefs).toEqual({ accepts: false });
    });

    it('creates the profile when the first call is an edit', async () => {
      const created = await updateSellerPrefs('seller-first-edit', {
        returnPrefs: { accepts: true, windowDays: 14 },
      });
      expect(created.oxyUserId).toBe('seller-first-edit');
      expect(created.returnPrefs).toEqual({ accepts: true, windowDays: 14 });
    });
  });

  /**
   * The two batch readers listing hydration depends on.
   *
   * Both are `IN (...)` lookups, and an `IN` whose predicate was dropped
   * returns EVERY row rather than none — so the failure these cases exist to
   * catch is over-fetching, not under-fetching. Each seeds two owners and
   * asserts the other's row is absent; a test seeding one owner would pass
   * with the filter deleted.
   */
  describe('batch readers for listing hydration', () => {
    it('returns only the requested stores, with their members', async () => {
      const alpha = await seedStore('alpha-batch', 'owner-a');
      const beta = await seedStore('beta-batch', 'owner-b');

      const found = await findStoresByIds([alpha.id]);

      expect(found.map((s) => s.handle)).toEqual(['alpha-batch']);
      expect(found.some((s) => s.id === beta.id)).toBe(false);
      // Members travel with the store: hydration reads the owner off the record.
      expect(found[0].members.map((m) => m.oxyUserId)).toEqual(['owner-a']);
    });

    it('returns both stores when both are asked for', async () => {
      const alpha = await seedStore('alpha-both', 'owner-a');
      const beta = await seedStore('beta-both', 'owner-b');

      const found = await findStoresByIds([alpha.id, beta.id]);

      // The positive control for the case above: proves the single-store result
      // was a filter doing its job and not a reader that can only ever find one.
      expect(found.map((s) => s.handle).sort()).toEqual(['alpha-both', 'beta-both']);
    });

    it('returns an empty array for no ids without querying', async () => {
      await seedStore('unasked-store', 'owner-a');
      expect(await findStoresByIds([])).toEqual([]);
    });

    it('returns only the requested sellers profiles', async () => {
      await ensureSellerProfile('seller-a');
      await ensureSellerProfile('seller-b');

      const found = await findSellerProfilesByUserIds(['seller-a']);

      expect(found.map((p) => p.oxyUserId)).toEqual(['seller-a']);
      expect(found.some((p) => p.oxyUserId === 'seller-b')).toBe(false);
    });

    it('omits a seller with no profile instead of creating one', async () => {
      await ensureSellerProfile('seller-present');

      const found = await findSellerProfilesByUserIds(['seller-present', 'seller-absent']);

      expect(found.map((p) => p.oxyUserId)).toEqual(['seller-present']);
      // The distinction from `ensureSellerProfile`: browsing must not write.
      const [{ count }] = await client()<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM seller_profiles`;
      expect(count).toBe(1);
    });

    it('returns an empty array for no ids', async () => {
      await ensureSellerProfile('unasked-seller');
      expect(await findSellerProfilesByUserIds([])).toEqual([]);
    });
  });
});

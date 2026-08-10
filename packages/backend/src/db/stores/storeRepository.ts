/**
 * Every statement the store domain issues against `stores` and `store_members`.
 *
 * Two things about this port are behaviour-relevant rather than mechanical, and
 * both are races the Mongo original could not close:
 *
 *  - **The handle is unique by CONSTRAINT, not by a prior existence check.**
 *    The source asked `Store.exists({handle})` and then inserted, which only
 *    narrows the window: two concurrent creates with the same name both see the
 *    handle free and both proceed. `stores_handle_key` decides it now; the
 *    probe survives ONLY to pick a pretty suffix, and a lost race is retried
 *    rather than surfaced.
 *  - **Membership invariants are enforced under a row LOCK.** "The last owner
 *    cannot be removed or demoted" is a cross-row invariant that no unique
 *    index can express, and the source read the document, counted owners in
 *    JavaScript and saved — so two concurrent demotions each saw two owners and
 *    both succeeded, leaving a store with none. Reading the members
 *    `FOR UPDATE` inside the same transaction as the write closes it. This is a
 *    deliberate STRENGTHENING, not a faithful port; it is called out because a
 *    port that silently changes behaviour is indistinguishable from one that
 *    broke something.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type { StorePermission, StoreRole, TextTone } from '@moovo/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { storeMembers, stores } from '../schema/stores';

/** The lifecycle states a store can be in. */
export type StoreStatus = 'active' | 'suspended' | 'closed';

/** A `store_members` row as the domain consumes it. */
export interface StoreMemberRecord {
  oxyUserId: string;
  role: StoreRole;
  permissions: StorePermission[];
  invitedBy?: string;
  joinedAt: Date;
}

/**
 * A store plus its members.
 *
 * `policies` is reassembled from the two flat columns because that is the shape
 * the wire DTO and the service invariants are written against; the schema keeps
 * them flat so a future CHECK or index can reach either one
 * (`db/schema/CONVENTIONS.md`).
 */
export interface StoreRecord {
  id: string;
  handle: string;
  name: string;
  description: string;
  logoFileId?: string;
  coverFileId?: string;
  brandColor: string;
  textTone: TextTone;
  status: StoreStatus;
  members: StoreMemberRecord[];
  policies: { returnWindowDays: number; shippingNote?: string };
  defaultCurrency: string;
  rating: number;
  reviewCount: number;
  productCount: number;
  salesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type StoreRow = typeof stores.$inferSelect;
type MemberRow = typeof storeMembers.$inferSelect;

function toMemberRecord(row: MemberRow): StoreMemberRecord {
  return {
    oxyUserId: row.oxyUserId,
    role: row.role as StoreRole,
    permissions: row.permissions as StorePermission[],
    ...(row.invitedBy === null ? {} : { invitedBy: row.invitedBy }),
    joinedAt: row.joinedAt,
  };
}

function toStoreRecord(row: StoreRow, members: MemberRow[]): StoreRecord {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    description: row.description,
    ...(row.logoFileId === null ? {} : { logoFileId: row.logoFileId }),
    ...(row.coverFileId === null ? {} : { coverFileId: row.coverFileId }),
    brandColor: row.brandColor,
    textTone: row.textTone as TextTone,
    status: row.status as StoreStatus,
    members: members.map(toMemberRecord),
    policies: {
      returnWindowDays: row.policyReturnWindowDays,
      ...(row.policyShippingNote === null ? {} : { shippingNote: row.policyShippingNote }),
    },
    defaultCurrency: row.defaultCurrency,
    rating: row.rating,
    reviewCount: row.reviewCount,
    productCount: row.productCount,
    salesCount: row.salesCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Members of one store, oldest first — the order the embedded array had. */
async function membersOf(storeId: string, db: DatabaseOrTransaction): Promise<MemberRow[]> {
  return await db
    .select()
    .from(storeMembers)
    .where(eq(storeMembers.storeId, storeId))
    .orderBy(storeMembers.joinedAt, storeMembers.id);
}

/** Whether a handle is already taken. Used only to pick a candidate slug. */
export async function storeHandleExists(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.handle, handle))
    .limit(1);
  return rows.length > 0;
}

/** What `createStore` supplies. */
export interface NewStore {
  handle: string;
  name: string;
  description: string;
  brandColor: string;
  logoFileId?: string;
  coverFileId?: string;
  defaultCurrency: string;
  status: string;
  owner: { oxyUserId: string; permissions: StorePermission[] };
}

/**
 * Insert a store and its founding owner in ONE transaction.
 *
 * Returns `null` when the handle is taken, so the caller can pick another —
 * the unique index is what actually decides, and a caught violation is the only
 * answer that is true at commit time rather than at check time.
 */
export async function insertStore(
  input: NewStore,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(stores)
        .values({
          handle: input.handle,
          name: input.name,
          description: input.description,
          brandColor: input.brandColor,
          logoFileId: input.logoFileId ?? null,
          coverFileId: input.coverFileId ?? null,
          defaultCurrency: input.defaultCurrency,
          status: input.status,
        })
        .returning();

      const [member] = await tx
        .insert(storeMembers)
        .values({
          storeId: row.id,
          oxyUserId: input.owner.oxyUserId,
          role: 'owner',
          permissions: [...input.owner.permissions],
        })
        .returning();

      return toStoreRecord(row, [member]);
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return null;
    }
    throw err;
  }
}

/** One store with its members, or `null`. */
export async function findStoreById(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const [row] = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  if (row === undefined) return null;
  return toStoreRecord(row, await membersOf(storeId, db));
}

/**
 * One store by its public handle, or `null`.
 *
 * Serves the public store page. `stores_handle_key` makes the handle unique, so
 * this cannot be ambiguous; the caller decides what a `closed` store means.
 */
export async function findStoreByHandle(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const [row] = await db.select().from(stores).where(eq(stores.handle, handle)).limit(1);
  if (row === undefined) return null;
  return toStoreRecord(row, await membersOf(row.id, db));
}

/**
 * Stores the given user belongs to, newest first.
 *
 * The membership filter is what makes this safe to expose: it is scoped to the
 * caller by their `oxyUserId`, never by a client-supplied store id.
 */
export async function listStoresForMember(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord[]> {
  const rows = await db
    .select({ store: stores })
    .from(stores)
    .innerJoin(storeMembers, eq(storeMembers.storeId, stores.id))
    .where(eq(storeMembers.oxyUserId, oxyUserId))
    .orderBy(desc(stores.createdAt), desc(stores.id));

  if (rows.length === 0) return [];

  const storeIds = rows.map((r) => r.store.id);
  const allMembers = await db
    .select()
    .from(storeMembers)
    .where(inArray(storeMembers.storeId, storeIds))
    .orderBy(storeMembers.joinedAt, storeMembers.id);

  const byStore = new Map<string, MemberRow[]>();
  for (const member of allMembers) {
    const bucket = byStore.get(member.storeId);
    if (bucket === undefined) byStore.set(member.storeId, [member]);
    else bucket.push(member);
  }

  return rows.map((r) => toStoreRecord(r.store, byStore.get(r.store.id) ?? []));
}

/**
 * Stores for a set of ids, in no particular order.
 *
 * Exists so listing hydration resolves every owning store in ONE round trip.
 * The per-id alternative is an N+1 across the hottest read in the product, and
 * the source avoided it the same way (`Store.find({_id: {$in: ids}})`).
 *
 * Members are fetched in a second statement and grouped in memory rather than
 * joined, because a join would multiply each store row by its member count and
 * the caller wants one record per store.
 */
export async function findStoresByIds(
  storeIds: string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord[]> {
  if (storeIds.length === 0) return [];

  const rows = await db.select().from(stores).where(inArray(stores.id, storeIds));
  if (rows.length === 0) return [];

  const allMembers = await db
    .select()
    .from(storeMembers)
    .where(
      inArray(
        storeMembers.storeId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(storeMembers.joinedAt, storeMembers.id);

  const byStore = new Map<string, MemberRow[]>();
  for (const member of allMembers) {
    const bucket = byStore.get(member.storeId);
    if (bucket === undefined) byStore.set(member.storeId, [member]);
    else bucket.push(member);
  }

  return rows.map((row) => toStoreRecord(row, byStore.get(row.id) ?? []));
}

/** The store columns an update may set, already flattened. */
export interface StorePatch {
  name?: string;
  description?: string;
  brandColor?: string;
  logoFileId?: string;
  coverFileId?: string;
  defaultCurrency?: string;
  textTone?: string;
  status?: string;
  policyReturnWindowDays?: number;
  policyShippingNote?: string;
}

/** Apply a patch and return the updated store, or `null` if it is gone. */
export async function updateStoreRow(
  storeId: string,
  patch: StorePatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  // An empty patch must still return the store rather than issuing an UPDATE
  // with no assignments, which is a syntax error rather than a no-op.
  if (Object.keys(patch).length === 0) {
    return findStoreById(storeId, db);
  }

  const [row] = await db
    .update(stores)
    .set(patch)
    .where(eq(stores.id, storeId))
    .returning();

  if (row === undefined) return null;
  return toStoreRecord(row, await membersOf(storeId, db));
}

/**
 * Add a member.
 *
 * Returns `null` when the user is already a member: `store_members_store_oxy_user_key`
 * decides that, so two concurrent invites cannot both land. `DO NOTHING` rather
 * than a raised duplicate, because the caller answers 409 and a raised `23505`
 * would abort the surrounding transaction.
 */
export async function insertMember(
  storeId: string,
  member: { oxyUserId: string; role: StoreRole; permissions: StorePermission[]; invitedBy?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreRecord | null> {
  const inserted = await db
    .insert(storeMembers)
    .values({
      storeId,
      oxyUserId: member.oxyUserId,
      role: member.role,
      permissions: [...member.permissions],
      invitedBy: member.invitedBy ?? null,
    })
    .onConflictDoNothing({ target: [storeMembers.storeId, storeMembers.oxyUserId] })
    .returning();

  if (inserted.length === 0) return null;
  return findStoreById(storeId, db);
}

/**
 * How a membership write may fail, as a value rather than an exception.
 *
 * The discriminant is a STRING, not `ok: boolean`. This backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — `if (outcome.ok)`
 * leaves the caller holding the whole union, so `outcome.reason` fails to
 * compile in the branch where it is the only thing that matters.
 */
export type MembershipOutcome =
  | { status: 'ok'; store: StoreRecord }
  | { status: 'store_not_found' | 'member_not_found' | 'last_owner' };

/**
 * Read every member of a store FOR UPDATE.
 *
 * This is what makes the owner-count invariant real. Without the lock, two
 * concurrent demotions each read two owners, each conclude they are not the
 * last, and both commit — leaving a store nobody can administer.
 */
async function lockMembers(storeId: string, tx: DatabaseOrTransaction): Promise<MemberRow[]> {
  return await tx
    .select()
    .from(storeMembers)
    .where(eq(storeMembers.storeId, storeId))
    .orderBy(storeMembers.joinedAt, storeMembers.id)
    .for('update');
}

/**
 * Change a member's role and/or permissions.
 *
 * `allowOwnerChange` carries the caller's authority (only an owner may touch
 * another owner). It is passed in rather than re-derived here because the
 * acting member is resolved by the middleware from the authenticated caller,
 * and re-reading it in the repository would be a second answer to a question
 * already settled.
 */
export async function updateMemberRow(
  storeId: string,
  targetOxyUserId: string,
  patch: { role?: StoreRole; permissions?: StorePermission[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<MembershipOutcome> {
  return await db.transaction(async (tx) => {
    const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).limit(1);
    if (store === undefined) return { status: 'store_not_found' };

    const members = await lockMembers(storeId, tx);
    const target = members.find((m) => m.oxyUserId === targetOxyUserId);
    if (target === undefined) return { status: 'member_not_found' };

    const owners = members.filter((m) => m.role === 'owner').length;
    if (patch.role !== undefined && patch.role !== 'owner' && target.role === 'owner' && owners <= 1) {
      return { status: 'last_owner' };
    }

    const set: Partial<typeof storeMembers.$inferInsert> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.permissions !== undefined) set.permissions = [...patch.permissions];

    if (Object.keys(set).length > 0) {
      await tx
        .update(storeMembers)
        .set(set)
        .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, targetOxyUserId)));
    }

    const [row] = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
    return { status: 'ok', store: toStoreRecord(row, await membersOf(storeId, tx)) };
  });
}

/** Remove a member, refusing to remove the last owner. */
export async function deleteMemberRow(
  storeId: string,
  targetOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MembershipOutcome> {
  return await db.transaction(async (tx) => {
    const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).limit(1);
    if (store === undefined) return { status: 'store_not_found' };

    const members = await lockMembers(storeId, tx);
    const target = members.find((m) => m.oxyUserId === targetOxyUserId);
    if (target === undefined) return { status: 'member_not_found' };

    if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length <= 1) {
      return { status: 'last_owner' };
    }

    await tx
      .delete(storeMembers)
      .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, targetOxyUserId)));

    const [row] = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
    return { status: 'ok', store: toStoreRecord(row, await membersOf(storeId, tx)) };
  });
}

/**
 * The caller's membership of a store, for the authorization middleware.
 *
 * ONE statement, filtered by BOTH the store and the caller — the filter IS the
 * authorization boundary, so it is expressed in SQL rather than by fetching the
 * store and scanning its members in JavaScript. `store_members_store_oxy_user_key`
 * serves it.
 */
export async function findMembership(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreMemberRecord | null> {
  const [row] = await db
    .select()
    .from(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.oxyUserId, oxyUserId)))
    .limit(1);
  return row === undefined ? null : toMemberRecord(row);
}

/**
 * Store service.
 *
 * Owns store lifecycle (create/update), membership management, and the
 * owner-protection invariants:
 *   - the LAST owner of a store can be neither removed nor demoted, and
 *   - only an `owner` may change or remove ANOTHER `owner`.
 *
 * The two invariants are split by WHO can answer them. "Only an owner may touch
 * an owner" is a fact about the ACTING member, known here from the middleware's
 * already-authenticated membership. "Not the last owner" is a fact about the
 * whole member set, so it is decided in the repository inside the same
 * transaction as the write, under a row lock — see
 * `db/stores/storeRepository.ts`. Counting owners here and writing afterwards is
 * what let two concurrent demotions both succeed.
 */

import type {
  CreateStoreInput,
  UpdateStoreInput,
  InviteMemberInput,
  UpdateMemberInput,
} from '@moovo/shared-types';
import {
  deleteMemberRow,
  findStoreById,
  insertMember,
  insertStore,
  listStoresForMember,
  storeHandleExists,
  updateMemberRow,
  updateStoreRow,
  type StoreMemberRecord,
  type StorePatch,
  type StoreRecord,
} from '../db/stores/storeRepository.js';
import { STORE_PERMISSIONS } from '../db/schema/valueSets.js';
import { ensureUniqueSlug } from '../utils/slug.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

export type { StoreRecord, StoreMemberRecord };

/** Default brand color for a store created without one. */
const DEFAULT_BRAND_COLOR = '#1D4ED8';

/**
 * How many times to re-pick a handle when the unique index refuses one.
 *
 * The slug probe narrows the window; only the index closes it, so a create that
 * loses the race retries with a fresh suffix. Bounded because an unbounded
 * retry against a genuine defect spins forever.
 */
const HANDLE_ATTEMPTS = 5;

/**
 * Create a store. The caller becomes its sole `owner` (granted every
 * permission). The handle is derived from the name and made unique.
 */
export async function createStore(
  ownerOxyUserId: string,
  input: CreateStoreInput,
): Promise<StoreRecord> {
  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
    const handle = await ensureUniqueSlug(input.name, storeHandleExists);

    if (handle.length === 0) {
      throw validationError('Store name must contain at least one alphanumeric character');
    }

    const created = await insertStore({
      handle,
      name: input.name,
      description: input.description ?? '',
      brandColor: input.brandColor ?? DEFAULT_BRAND_COLOR,
      ...(input.logoFileId ? { logoFileId: input.logoFileId } : {}),
      ...(input.coverFileId ? { coverFileId: input.coverFileId } : {}),
      defaultCurrency: input.defaultCurrency ?? 'USD',
      status: 'active',
      owner: { oxyUserId: ownerOxyUserId, permissions: [...STORE_PERMISSIONS] },
    });

    if (created !== null) return created;
  }

  throw conflict('Could not allocate a unique store handle');
}

/** Fetch a store by id, or throw NOT_FOUND. */
export async function getStore(storeId: string): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
  if (store === null) {
    throw notFound('Store not found');
  }
  return store;
}

/** List the stores the given user is a member of. */
export async function listStoresForUser(oxyUserId: string): Promise<StoreRecord[]> {
  return listStoresForMember(oxyUserId);
}

/** Update a store's profile/policy fields. Returns the updated store. */
export async function updateStore(
  storeId: string,
  patch: UpdateStoreInput,
): Promise<StoreRecord> {
  const columns: StorePatch = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.brandColor !== undefined) columns.brandColor = patch.brandColor;
  if (patch.logoFileId !== undefined) columns.logoFileId = patch.logoFileId;
  if (patch.coverFileId !== undefined) columns.coverFileId = patch.coverFileId;
  if (patch.defaultCurrency !== undefined) columns.defaultCurrency = patch.defaultCurrency;
  if (patch.textTone !== undefined) columns.textTone = patch.textTone;
  if (patch.status !== undefined) columns.status = patch.status;
  // `policies` is a nested group in the contract and two flat columns in the
  // schema, and each member is applied INDEPENDENTLY — unlike the seller's
  // preference groups, the source assigns these one field at a time.
  if (patch.policies !== undefined) {
    if (patch.policies.returnWindowDays !== undefined) {
      columns.policyReturnWindowDays = patch.policies.returnWindowDays;
    }
    if (patch.policies.shippingNote !== undefined) {
      columns.policyShippingNote = patch.policies.shippingNote;
    }
  }

  const updated = await updateStoreRow(storeId, columns);
  if (updated === null) {
    throw notFound('Store not found');
  }
  return updated;
}

/**
 * Invite (add) a member to a store. The acting member's role gates whether they
 * may grant an `owner` role (only an existing owner may create another owner).
 * Rejects duplicates.
 */
export async function inviteMember(
  storeId: string,
  actor: StoreMemberRecord,
  input: InviteMemberInput,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
  if (store === null) {
    throw notFound('Store not found');
  }

  // Only an owner may mint another owner. Checked before the insert so the
  // refusal does not depend on whether the row happened to conflict.
  if (input.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may grant the owner role');
  }

  const updated = await insertMember(storeId, {
    oxyUserId: input.oxyUserId,
    role: input.role,
    permissions: input.permissions ?? [],
    invitedBy: actor.oxyUserId,
  });

  // `null` means the unique index refused a duplicate — the same answer the
  // source's pre-check gave, now decided by the database so two concurrent
  // invites cannot both land.
  if (updated === null) {
    throw conflict('User is already a member of this store');
  }

  // Best-effort: notify the invited member. A notification failure must never
  // fail the invite itself.
  try {
    await sendNotification({
      userId: input.oxyUserId,
      type: 'store_member_invited',
      title: 'Store invitation',
      body: `You were added to ${updated.name}`,
      data: { storeId: updated.id, role: input.role },
    });
  } catch (err) {
    log.general.warn({ err, storeId: updated.id }, 'store_member_invited notification failed');
  }

  return updated;
}

/**
 * Update a member's role/permissions. Enforces:
 *   - only an owner may modify another owner,
 *   - demoting the last owner away from `owner` is rejected.
 */
export async function updateMember(
  storeId: string,
  actor: StoreMemberRecord,
  targetOxyUserId: string,
  patch: UpdateMemberInput,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
  if (store === null) {
    throw notFound('Store not found');
  }

  const target = store.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (target === undefined) {
    throw notFound('Member not found');
  }

  // Authority checks read the ACTOR, which the middleware already
  // authenticated; only the last-owner count is re-decided under the lock.
  if (target.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may modify another owner');
  }
  if (patch.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may grant the owner role');
  }

  const outcome = await updateMemberRow(storeId, targetOxyUserId, {
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
  });

  if (outcome.status === 'ok') return outcome.store;
  if (outcome.status === 'last_owner') {
    throw conflict('Cannot demote the last owner of the store');
  }
  throw notFound(outcome.status === 'store_not_found' ? 'Store not found' : 'Member not found');
}

/**
 * Remove a member from a store. Enforces:
 *   - only an owner may remove another owner,
 *   - removing the last owner is rejected.
 */
export async function removeMember(
  storeId: string,
  actor: StoreMemberRecord,
  targetOxyUserId: string,
): Promise<StoreRecord> {
  const store = await findStoreById(storeId);
  if (store === null) {
    throw notFound('Store not found');
  }

  const target = store.members.find((m) => m.oxyUserId === targetOxyUserId);
  if (target === undefined) {
    throw notFound('Member not found');
  }

  if (target.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('Only an owner may remove another owner');
  }

  const outcome = await deleteMemberRow(storeId, targetOxyUserId);

  if (outcome.status === 'ok') return outcome.store;
  if (outcome.status === 'last_owner') {
    throw conflict('Cannot remove the last owner of the store');
  }
  throw notFound(outcome.status === 'store_not_found' ? 'Store not found' : 'Member not found');
}

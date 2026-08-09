/**
 * Address service — the buyer's saved shipping addresses.
 *
 * All operations are scoped to `oxyUserId`. The single-default invariant lives
 * here: promoting an address to `isDefault: true` first clears the previous
 * default for that user, so at most one default ever exists. The first address
 * a user creates becomes their default automatically.
 *
 * Promotion and deletion each take TWO statements, and this is the first domain
 * of the port where that matters: between "clear the others" and "set this one"
 * the user has no default at all, and between "delete" and "promote the newest
 * survivor" the same. Both run inside `db.transaction(...)` and thread the
 * handle down, so a crash cannot leave an account with two defaults or none.
 */

import type {
  Address as AddressDTO,
  CreateAddressInput,
  UpdateAddressInput,
} from '@moovo/shared-types';
import {
  clearDefaultAddresses,
  deleteAddressForUser,
  findAddressForUser,
  findNewestAddressForUser,
  insertAddress,
  listAddressesForUser,
  setAddressDefault,
  updateAddressForUser,
  userHasAnyAddress,
  type AddressRow,
} from '../db/addresses/addressRepository.js';
import { getDb } from '../db/postgres.js';
import { notFound } from '../lib/errors/error-codes.js';

/**
 * Serialize a stored row to the wire `Address` DTO.
 *
 * `!== null`, not `!== undefined`: Mongo omitted an unset optional while
 * Postgres returns `null`, and the old test passes for `null` — so a straight
 * translation would start emitting `{"label": null, "line2": null, ...}` where
 * the API emitted nothing.
 */
function toDTO(row: AddressRow): AddressDTO {
  const dto: AddressDTO = {
    id: row.id,
    recipientName: row.recipientName,
    line1: row.line1,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.label !== null) dto.label = row.label;
  if (row.line2 !== null) dto.line2 = row.line2;
  if (row.region !== null) dto.region = row.region;
  if (row.phone !== null) dto.phone = row.phone;
  return dto;
}

/** List the buyer's addresses, default first then newest. */
export async function list(oxyUserId: string): Promise<AddressDTO[]> {
  const rows = await listAddressesForUser(oxyUserId);
  return rows.map(toDTO);
}

/**
 * Create an address for the buyer. The user's FIRST address becomes their
 * default automatically; subsequent ones default to non-default.
 *
 * The existence check and the insert run in ONE transaction. That narrows the
 * window the source already had — it read and then wrote on separate
 * connections — but does NOT close it: under READ COMMITTED two concurrent
 * first-time creates can both observe no rows and both claim the default. The
 * only real fix is a partial unique index on `(oxy_user_id) WHERE is_default`,
 * which is a schema decision with its own migration and its own consequences
 * for the promotion path below (which is briefly in a state that index would
 * reject unless the two statements are ordered clear-then-set, as they are).
 * Recording it rather than half-fixing it: a transaction here reads like the
 * race is handled, and it is not.
 */
export async function create(
  oxyUserId: string,
  input: CreateAddressInput,
): Promise<AddressDTO> {
  const row = await getDb().transaction(async (tx) => {
    const isDefault = !(await userHasAnyAddress(oxyUserId, tx));
    return await insertAddress(
      {
        oxyUserId,
        label: input.label,
        recipientName: input.recipientName,
        line1: input.line1,
        line2: input.line2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        country: input.country,
        phone: input.phone,
        isDefault,
      },
      tx,
    );
  });

  return toDTO(row);
}

/**
 * Update an address (scoped to the buyer). Setting `isDefault: true` promotes
 * this address and clears the previous default. Setting it `false` is allowed
 * but does not auto-promote another address.
 */
export async function update(
  oxyUserId: string,
  addressId: string,
  patch: UpdateAddressInput,
): Promise<AddressDTO> {
  const row = await getDb().transaction(async (tx) => {
    const existing = await findAddressForUser(oxyUserId, addressId, tx);
    if (existing === null) {
      throw notFound('Address not found');
    }

    // Clear BEFORE setting, so the two states this passes through are "no
    // default" and "exactly one" — never "two", which is the order a partial
    // unique index would reject if one is ever added.
    if (patch.isDefault === true) {
      await clearDefaultAddresses(oxyUserId, addressId, tx);
    }

    const updated = await updateAddressForUser(
      oxyUserId,
      addressId,
      {
        label: patch.label,
        recipientName: patch.recipientName,
        line1: patch.line1,
        line2: patch.line2,
        city: patch.city,
        region: patch.region,
        postalCode: patch.postalCode,
        country: patch.country,
        phone: patch.phone,
        isDefault: patch.isDefault,
      },
      tx,
    );
    if (updated === null) {
      throw notFound('Address not found');
    }
    return updated;
  });

  return toDTO(row);
}

/**
 * Remove an address (scoped to the buyer). If the removed address was the
 * default, the user's newest remaining address (if any) is promoted to default
 * so the buyer always has a default when at least one address exists.
 */
export async function remove(oxyUserId: string, addressId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const existing = await findAddressForUser(oxyUserId, addressId, tx);
    if (existing === null) {
      throw notFound('Address not found');
    }

    await deleteAddressForUser(oxyUserId, addressId, tx);

    if (existing.isDefault) {
      const next = await findNewestAddressForUser(oxyUserId, tx);
      if (next !== null) {
        await setAddressDefault(next.id, tx);
      }
    }
  });
}

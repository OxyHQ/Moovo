/**
 * Every statement this service issues against `addresses`.
 *
 * This is the first domain whose invariant spans more than one statement — at
 * most one address per user carries `isDefault` — so it is the first place the
 * `db: DatabaseOrTransaction` parameter earns its keep rather than merely being
 * the convention. Promotion is "clear the others, then set this one", and
 * deletion is "delete, then promote the newest survivor"; each pair must commit
 * together or a user is left with two defaults or none. The SERVICE opens the
 * transaction and threads its handle through, which is exactly the shape that
 * would silently not work if these functions reached for `getDb()` themselves.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { addresses } from '../schema/commerce';

/** An `addresses` row exactly as stored. */
export type AddressRow = typeof addresses.$inferSelect;

/** What `insertAddress` needs. */
export interface NewAddress {
  oxyUserId: string;
  label?: string | undefined;
  recipientName: string;
  line1: string;
  line2?: string | undefined;
  city: string;
  region?: string | undefined;
  postalCode: string;
  country: string;
  phone?: string | undefined;
  isDefault: boolean;
}

/** The mutable fields of an address, all optional. */
export type AddressPatch = Partial<Omit<NewAddress, 'oxyUserId'>>;

/**
 * The buyer's addresses, default first then newest.
 *
 * `is_default DESC` puts `true` before `false` — Postgres orders booleans with
 * false first ascending — which matches the source's `{isDefault: -1}`. `id`
 * breaks the remaining ties so the order is total.
 */
export async function listAddressesForUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRow[]> {
  return await db
    .select()
    .from(addresses)
    .where(eq(addresses.oxyUserId, oxyUserId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt), desc(addresses.id));
}

/** One address, scoped to its owner. The ownership check is the WHERE clause. */
export async function findAddressForUser(
  oxyUserId: string,
  addressId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRow | null> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/** Whether the user has any address at all — decides whether a new one is their default. */
export async function userHasAnyAddress(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(eq(addresses.oxyUserId, oxyUserId))
    .limit(1);
  return rows.length > 0;
}

/** The user's newest address, for promotion after the default is deleted. */
export async function findNewestAddressForUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRow | null> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(eq(addresses.oxyUserId, oxyUserId))
    // `id` after `createdAt` for the same reason as everywhere else: two
    // addresses saved in the same millisecond would otherwise promote an
    // arbitrary one, and "arbitrary" is not reproducible in a bug report.
    .orderBy(desc(addresses.createdAt), desc(addresses.id))
    .limit(1);
  return row ?? null;
}

/** Store one address and return it. */
export async function insertAddress(
  input: NewAddress,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRow> {
  const [row] = await db
    .insert(addresses)
    .values({
      id: uuidv7(),
      oxyUserId: input.oxyUserId,
      label: input.label ?? null,
      recipientName: input.recipientName,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      region: input.region ?? null,
      postalCode: input.postalCode,
      country: input.country,
      phone: input.phone ?? null,
      isDefault: input.isDefault,
    })
    .returning();

  if (row === undefined) {
    throw new Error('Inserting an address returned no row.');
  }
  return row;
}

/**
 * Apply a patch to one of the user's addresses and return the stored row.
 *
 * Only the keys present in `patch` are written. An `undefined` value means "do
 * not touch"; the source distinguishes that from an explicit clear, and a
 * blanket `set(patch)` would write `null` over every field the caller omitted.
 */
export async function updateAddressForUser(
  oxyUserId: string,
  addressId: string,
  patch: AddressPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRow | null> {
  // Dropping `undefined` here and the emptiness check below are ONE behaviour,
  // not two independent guards — worth stating, because drizzle's
  // `mapUpdateSet` already filters `undefined` out of a `set`, so the filter
  // looks redundant in isolation.
  //
  // It is not. `address.service` always passes all ten keys, `undefined` for
  // the ones the caller omitted, so without this filter `values` is never
  // empty and the check below never fires. The UPDATE then still runs — it
  // does not fail, because `updatedAt` below is always a real value, so
  // drizzle has exactly one column to set. The result is a statement that
  // writes nothing except a new `updated_at`, silently, on a request that
  // asked for no change. With the filter, that request is answered as the read
  // it is.
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  if (Object.keys(values).length === 0) {
    return await findAddressForUser(oxyUserId, addressId, db);
  }

  const [row] = await db
    .update(addresses)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
    .returning();
  return row ?? null;
}

/**
 * Clear `isDefault` on the user's other addresses.
 *
 * MUST run in the same transaction as the promotion it precedes: between the
 * two statements the user has no default at all, and a crash there is what
 * leaves an account whose checkout cannot preselect an address.
 */
export async function clearDefaultAddresses(
  oxyUserId: string,
  exceptAddressId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const clauses = [eq(addresses.oxyUserId, oxyUserId), eq(addresses.isDefault, true)];
  if (exceptAddressId !== undefined) clauses.push(ne(addresses.id, exceptAddressId));
  await db.update(addresses).set({ isDefault: false }).where(and(...clauses));
}

/** Promote one address to default. Pairs with `clearDefaultAddresses`. */
export async function setAddressDefault(
  addressId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(addresses)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(addresses.id, addressId));
}

/** Delete one of the user's addresses. Returns whether it existed. */
export async function deleteAddressForUser(
  oxyUserId: string,
  addressId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .delete(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)));
  return (result.count ?? 0) > 0;
}

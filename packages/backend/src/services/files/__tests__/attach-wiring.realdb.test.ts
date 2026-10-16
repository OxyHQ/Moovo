/**
 * Every write path that accepts a file id checks ownership BEFORE it writes —
 * asserted against the real write paths and a real database, so "refused"
 * also means "nothing was stored".
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { categories, listings } from '../../../db/schema/catalog';
import { stores } from '../../../db/schema/stores';
import { shipments } from '../../../db/schema/transport';
import { rejectionOf } from '../../../__tests__/fixtures/runner-compat';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';
import { createP2PListing, updateListing } from '../../catalog-write.service';
import { createStore, updateStore } from '../../store.service';
import { createShipment } from '../../shipment.service';
import { setFileMetadataReaderForTesting } from '../file-ownership';
import type { CreateShipmentInput } from '@moovo/shared-types';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const SELLER = `seller-${uuidv7()}`;
const files = { ownerIds: new Set([SELLER]) };
const [MINE, MINE_TOO, THEIRS] = [uuidv7(), uuidv7(), uuidv7()];

function isRefusal(error: unknown): boolean {
  return isMoovoError(error) && error.code === ErrorCodes.VALIDATION_ERROR;
}

describeIfPostgres('ownership at every file-accepting write', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    await requireSuite(suite)
      .db.insert(categories)
      .values({ name: 'gadgets', slug: 'gadgets' })
      .onConflictDoNothing();
  });

  afterEach(() => {
    setFileMetadataReaderForTesting();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  const db = () => requireSuite(suite).db;

  function oxyOwners(owners: Record<string, string>): void {
    setFileMetadataReaderForTesting(async (ids) =>
      ids.flatMap((id) =>
        owners[id] ? [{ id, mime: 'image/jpeg', status: 'active', ownerUserId: owners[id] }] : [],
      ),
    );
  }

  const listingInput = (imageFileIds: string[]) => ({
    title: 'Bike',
    description: '',
    condition: 'used' as const,
    category: 'gadgets',
    imageFileIds,
    price: { amount: 1000, currency: 'USD' as const },
    quantity: 1,
  });

  it('a listing: the seller’s photos are stored, a stranger’s refuse the whole write', async () => {
    oxyOwners({ [MINE]: SELLER, [MINE_TOO]: SELLER, [THEIRS]: 'stranger' });
    const id = await createP2PListing(SELLER, listingInput([MINE]), files);
    const [row] = await db().select().from(listings).where(eq(listings.id, id));
    expect(row?.images).toEqual([{ fileId: MINE, position: 0 }]);

    const before = (await db().select().from(listings)).length;
    expect(
      isRefusal(await rejectionOf(createP2PListing(SELLER, listingInput([THEIRS]), files))),
    ).toBe(true);
    expect((await db().select().from(listings)).length).toBe(before);

    // An edit keeps what the listing holds and checks only what it adds.
    oxyOwners({ [MINE_TOO]: SELLER });
    await updateListing(id, { imageFileIds: [MINE, MINE_TOO] }, files);
    expect(
      isRefusal(await rejectionOf(updateListing(id, { imageFileIds: [MINE, THEIRS] }, files))),
    ).toBe(true);
    const [after] = await db().select().from(listings).where(eq(listings.id, id));
    const kept = (after?.images ?? []) as { fileId: string }[];
    expect(kept.map((image) => image.fileId)).toEqual([MINE, MINE_TOO]);
  });

  it('a store: a stranger’s logo is refused on create and on update', async () => {
    oxyOwners({ [MINE]: SELLER, [THEIRS]: 'stranger' });
    expect(
      isRefusal(
        await rejectionOf(createStore(SELLER, { name: 'Refused shop', logoFileId: THEIRS }, files)),
      ),
    ).toBe(true);
    const store = await createStore(SELLER, { name: 'My shop', logoFileId: MINE }, files);
    expect(
      isRefusal(await rejectionOf(updateStore(store.id, { coverFileId: THEIRS }, files))),
    ).toBe(true);
    const [row] = await db().select().from(stores).where(eq(stores.id, store.id));
    expect([row?.logoFileId, row?.coverFileId]).toEqual([MINE, null]);
  });

  it('a shipment: a stranger’s photo, or too many photos, is refused before anything is stored', async () => {
    oxyOwners({ [THEIRS]: 'stranger' });
    const point = { type: 'Point' as const, coordinates: [2.17, 41.38] as [number, number] };
    const address = {
      name: 'A',
      phone: '+34600000000',
      line1: 'Carrer 1',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
      location: point,
    };
    const input = (photos: { fileId: string; position: number }[]) =>
      ({
        type: 'package',
        pickup: address,
        dropoff: address,
        parcel: { sizeClass: 'small', weightKg: 1 },
        itemDescription: 'Box',
        photos,
      }) as unknown as CreateShipmentInput;

    const before = (await db().select().from(shipments)).length;
    expect(
      isRefusal(
        await rejectionOf(createShipment(SELLER, input([{ fileId: THEIRS, position: 0 }]), files)),
      ),
    ).toBe(true);
    const tooMany = Array.from({ length: 13 }, (_, position) => ({ fileId: uuidv7(), position }));
    expect(isRefusal(await rejectionOf(createShipment(SELLER, input(tooMany), files)))).toBe(true);
    expect((await db().select().from(shipments)).length).toBe(before);
  });
});

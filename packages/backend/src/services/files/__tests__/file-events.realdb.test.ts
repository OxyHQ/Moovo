/**
 * File events against a REAL Postgres server: a takedown clears the file from
 * every Moovo row that shows it and records each column, a redelivery changes
 * nothing, an unblock puts back what the block cleared, and the clearing is an
 * ordinary write the reference triggers see.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { FileEvent } from '@oxy.so/core/server';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  type SuiteDatabase,
} from '../../../db/testDatabase';
import { categories, listings } from '../../../db/schema/catalog';
import { stores } from '../../../db/schema/stores';
import {
  fileEventReceipts,
  fileReferenceSyncs,
  fileTakedownActions,
} from '../../../db/schema/files';
import { handleFileEvent } from '../file-events.service';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

function event(
  type: FileEvent['type'],
  fileId: string,
  references: FileEvent['references'],
  ownerKind: FileEvent['file']['ownerKind'] = 'account',
): FileEvent {
  return {
    id: uuidv7(),
    type,
    occurredAt: new Date().toISOString(),
    file: { id: fileId, ownerKind, visibility: 'public', status: 'deleted' },
    references,
  };
}

describeIfPostgres('Oxy file events on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  const db = () => requireSuite(suite).db;

  async function listing(images: string[]) {
    const id = uuidv7();
    await db()
      .insert(listings)
      .values({
        id,
        ownerType: 'user',
        oxyUserId: 'seller',
        title: 'Bike',
        description: '',
        condition: 'used',
        status: 'active',
        images: images.map((fileId, position) => ({ fileId, position })),
      });
    return id;
  }

  async function store(logo: string | null) {
    const id = uuidv7();
    await db()
      .insert(stores)
      .values({
        id,
        handle: `s-${id}`,
        name: 'Shop',
        description: '',
        brandColor: '#000',
        logoFileId: logo,
      });
    return id;
  }

  async function imagesOf(listingId: string) {
    const [row] = await db()
      .select({ images: listings.images })
      .from(listings)
      .where(eq(listings.id, listingId));
    return row?.images as { fileId: string; position: number }[];
  }

  it('a block clears the file from every row that shows it, and records each column', async () => {
    const [blocked, other] = [uuidv7(), uuidv7()];
    const listingId = await listing([other, blocked]);
    const storeId = await store(blocked);
    await db().delete(fileReferenceSyncs);

    const outcome = await handleFileEvent(
      event('file.blocked', blocked, [
        { entityType: 'listing', entityId: listingId },
        { entityType: 'store', entityId: storeId },
        // A type this Moovo does not know is ignored, not fatal.
        { entityType: 'gallery', entityId: 'x' },
      ]),
    );

    expect(outcome.duplicate).toBe(false);
    expect(await imagesOf(listingId)).toEqual([{ fileId: other, position: 0 }]);
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBeNull();

    const actions = await db()
      .select()
      .from(fileTakedownActions)
      .where(eq(fileTakedownActions.fileId, blocked));
    expect(
      actions.map((a) => [a.entityType, a.field, a.action, a.position, a.eventType]).sort(),
    ).toEqual(
      [
        ['listing', 'images', 'cleared', 1, 'file.blocked'],
        ['store', 'logo_file_id', 'cleared', null, 'file.blocked'],
      ].sort(),
    );

    // The clearing is an ordinary write: the triggers enqueued the removals.
    const syncs = await db()
      .select()
      .from(fileReferenceSyncs)
      .where(eq(fileReferenceSyncs.fileId, blocked));
    expect(syncs.map((s) => s.entityType).sort()).toEqual(['listing', 'store']);
  });

  it('applies a redelivery exactly once', async () => {
    const file = uuidv7();
    const storeId = await store(file);
    const first = event('file.deleted', file, [{ entityType: 'store', entityId: storeId }]);
    await handleFileEvent(first);
    // The owner re-adds the same file; a late redelivery must not clear it again.
    await db().update(stores).set({ logoFileId: file }).where(eq(stores.id, storeId));
    const again = await handleFileEvent(first);
    expect(again).toEqual({ duplicate: true, changes: [] });
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBe(file);
    const receipts = await db()
      .select()
      .from(fileEventReceipts)
      .where(eq(fileEventReceipts.eventId, first.id));
    expect(receipts).toHaveLength(1);
  });

  it('finds a use Oxy holds no reference for yet, through the outbox', async () => {
    const file = uuidv7();
    // Written a moment ago: its reference is still in the outbox, so Oxy's
    // event cannot list it.
    const storeId = await store(file);
    await handleFileEvent(event('file.blocked', file, []));
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBeNull();
  });

  it('finds Moovo’s own category art directly, for a file the application owns', async () => {
    const file = uuidv7();
    const slug = `art-${uuidv7()}`;
    await db().insert(categories).values({ name: 'Art', slug, imageFileId: file });
    await db().delete(fileReferenceSyncs);
    await handleFileEvent(event('file.deleted', file, [], 'application'));
    const [category] = await db().select().from(categories).where(eq(categories.slug, slug));
    expect(category?.imageFileId).toBeNull();
  });

  it('an unblock puts the file back where the block took it from', async () => {
    const [blocked, a, b] = [uuidv7(), uuidv7(), uuidv7()];
    const listingId = await listing([a, blocked, b]);
    const storeId = await store(blocked);
    const refs = [
      { entityType: 'listing', entityId: listingId },
      { entityType: 'store', entityId: storeId },
    ];
    await handleFileEvent(event('file.blocked', blocked, refs));

    const outcome = await handleFileEvent(event('file.unblocked', blocked, []));
    expect(outcome.changes.map((c) => c.action).sort()).toEqual(['restored', 'restored']);
    expect((await imagesOf(listingId)).map((i) => i.fileId)).toEqual([a, blocked, b]);
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBe(blocked);

    // A second unblock has nothing left to answer.
    const second = await handleFileEvent(event('file.unblocked', blocked, []));
    expect(second.changes).toEqual([]);
  });

  it('an unblock never overwrites a slot that was reused meanwhile', async () => {
    const [blocked, replacement] = [uuidv7(), uuidv7()];
    const storeId = await store(blocked);
    await handleFileEvent(
      event('file.blocked', blocked, [{ entityType: 'store', entityId: storeId }]),
    );
    await db().update(stores).set({ logoFileId: replacement }).where(eq(stores.id, storeId));

    const outcome = await handleFileEvent(event('file.unblocked', blocked, []));
    expect(outcome.changes.map((c) => c.action)).toEqual(['restore_skipped']);
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBe(replacement);
  });

  it('never restores what a DELETE cleared', async () => {
    const file = uuidv7();
    const storeId = await store(file);
    await handleFileEvent(
      event('file.deleted', file, [{ entityType: 'store', entityId: storeId }]),
    );
    const outcome = await handleFileEvent(event('file.unblocked', file, []));
    expect(outcome.changes).toEqual([]);
    const restored = await db()
      .select()
      .from(fileTakedownActions)
      .where(and(eq(fileTakedownActions.fileId, file), eq(fileTakedownActions.action, 'restored')));
    expect(restored).toEqual([]);
  });

  it('leaves a trashed file in place: trash is the owner’s, and reversible', async () => {
    const file = uuidv7();
    const storeId = await store(file);
    const outcome = await handleFileEvent(
      event('file.trashed', file, [{ entityType: 'store', entityId: storeId }]),
    );
    expect(outcome).toEqual({ duplicate: false, changes: [] });
    const [shop] = await db().select().from(stores).where(eq(stores.id, storeId));
    expect(shop?.logoFileId).toBe(file);
  });
});

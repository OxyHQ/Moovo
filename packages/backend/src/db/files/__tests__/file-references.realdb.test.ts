/**
 * Moovo's file references against a REAL Postgres server: the triggers that
 * fill the outbox, the worker that drains it, the inventory reconciliation
 * reads, and the nightly schedule.
 *
 * Real, not mocked, because every property here lives in SQL — the triggers,
 * `moovo_entity_file_ids()`, `ON CONFLICT … DO UPDATE`, `SKIP LOCKED` — and a
 * mocked repository accepts all of it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { ServiceFileReference, ServiceReferenceInventoryItem } from '@oxy.so/core';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  type SuiteDatabase,
} from '../../testDatabase';
import { categories, listings } from '../../schema/catalog';
import { stores } from '../../schema/stores';
import { providers } from '../../schema/transport';
import { fileReferenceReconciliations, fileReferenceSyncs } from '../../schema/files';
import { FILE_REFERENCE_ENTITY_TYPES, FILE_REFERENCE_FIELDS } from '../../schema/valueSets';
import {
  claimFileReferenceSyncs,
  completeFileReferenceSync,
  streamEntityFileInventory,
} from '../fileReferenceRepository';
import { ENTITY_FILE_SLOTS } from '../fileTakedownRepository';
import {
  runFileReferenceSyncBatch,
  setFileReferenceClientForTesting,
  syncBackoffMs,
  type FileReferenceClient,
} from '../../../services/files/file-references.service';
import {
  nextNightlyRun,
  runDueReconciliation,
} from '../../../services/files/file-references.dispatcher';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

const fileId = () => uuidv7();

/** A fake Oxy that records every call and answers like the real one. */
function fakeOxy(overrides: Partial<FileReferenceClient> = {}) {
  const calls = {
    add: [] as ServiceFileReference[][],
    remove: [] as ServiceFileReference[][],
    reconcile: [] as {
      entityType: string;
      items: ServiceReferenceInventoryItem[];
      dryRun?: boolean;
    }[],
  };
  const client: FileReferenceClient = {
    add: async (references) => {
      calls.add.push(references);
      return references.map((reference) => ({ ...reference, result: 'created' as const }));
    },
    remove: async (references) => {
      calls.remove.push(references);
      return references.map((reference) => ({ ...reference, result: 'removed' as const }));
    },
    reconcile: async (entityType, items, options) => {
      const collected: ServiceReferenceInventoryItem[] = [];
      for await (const item of items) collected.push(item);
      calls.reconcile.push({ entityType, items: collected, dryRun: options.dryRun });
      return {
        sessionId: 's',
        entityType,
        dryRun: options.dryRun === true,
        added: collected.length,
        removed: 0,
        unchanged: 0,
        refused: 0,
      };
    },
    ...overrides,
  };
  return { client, calls };
}

describeIfPostgres('Oxy file references on Postgres', () => {
  let suite: SuiteDatabase | null = null;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    setFileReferenceClientForTesting();
    await destroySuiteDatabase(suite);
    suite = null;
  });

  afterEach(async () => {
    setFileReferenceClientForTesting();
    await requireSuite(suite).db.delete(fileReferenceSyncs);
  });

  const db = () => requireSuite(suite).db;

  async function pending(entityId: string) {
    return db()
      .select()
      .from(fileReferenceSyncs)
      .where(eq(fileReferenceSyncs.entityId, entityId))
      .orderBy(fileReferenceSyncs.fileId);
  }

  async function insertStore(logo: string | null, cover: string | null) {
    const id = uuidv7();
    await db()
      .insert(stores)
      .values({
        id,
        handle: `store-${id}`,
        name: 'Test store',
        description: '',
        brandColor: '#000000',
        logoFileId: logo,
        coverFileId: cover,
      });
    return id;
  }

  async function insertListing(images: unknown[]) {
    const id = uuidv7();
    await db().insert(listings).values({
      id,
      ownerType: 'user',
      oxyUserId: 'seller',
      title: 'A thing',
      description: '',
      condition: 'used',
      status: 'active',
      images,
    });
    return id;
  }

  describe('the triggers', () => {
    it('enqueue every file a new row uses, once each', async () => {
      const [logo, cover] = [fileId(), fileId()];
      const storeId = await insertStore(logo, cover);
      const rows = await pending(storeId);
      expect(rows.map((row) => row.fileId).sort()).toEqual([logo, cover].sort());
      expect(rows.every((row) => row.entityType === 'store' && row.generation === 1)).toBe(true);
    });

    it('enqueue only what an update CHANGED — the file dropped and the file added', async () => {
      const [logo, cover, next] = [fileId(), fileId(), fileId()];
      const storeId = await insertStore(logo, cover);
      await db().delete(fileReferenceSyncs);

      await db().update(stores).set({ coverFileId: next }).where(eq(stores.id, storeId));
      expect((await pending(storeId)).map((row) => row.fileId).sort()).toEqual(
        [cover, next].sort(),
      );
    });

    it('enqueue nothing for an update that leaves every file as it was', async () => {
      const storeId = await insertStore(fileId(), null);
      await db().delete(fileReferenceSyncs);
      await db().update(stores).set({ name: 'Renamed' }).where(eq(stores.id, storeId));
      await db()
        .update(stores)
        .set({ logoFileId: sql`${stores.logoFileId}` })
        .where(eq(stores.id, storeId));
      expect(await pending(storeId)).toEqual([]);
    });

    it('bump the generation when the same (entity, file) is enqueued again', async () => {
      const logo = fileId();
      const storeId = await insertStore(logo, null);
      await db().update(stores).set({ logoFileId: null }).where(eq(stores.id, storeId));
      const [row] = await pending(storeId);
      expect(row?.generation).toBe(2);
    });

    it('enqueue a deleted row’s files, so the reference is removed', async () => {
      const image = fileId();
      const listingId = await insertListing([{ fileId: image, position: 0 }]);
      await db().delete(fileReferenceSyncs);
      await db().delete(listings).where(eq(listings.id, listingId));
      expect((await pending(listingId)).map((row) => row.fileId)).toEqual([image]);
    });

    it('never treat a URL (or anything else that is not a file id) as a use', async () => {
      const image = fileId();
      const listingId = await insertListing([
        { fileId: 'https://cdn.example.com/a.jpg', position: 0 },
        { fileId: '', position: 1 },
        { fileId: image, position: 2 },
        'not-an-object',
      ]);
      expect((await pending(listingId)).map((row) => row.fileId)).toEqual([image]);
    });
  });

  describe('moovo_entity_file_ids()', () => {
    it('reads exactly the columns the takedown handler writes, for every entity type', async () => {
      // One synthetic row carrying a distinct id in EVERY file column any type
      // has. Each type must answer exactly the ids of its own slots — a column
      // the SQL reads that the takedown cannot clear (or the reverse) fails here.
      const ids = Object.fromEntries(FILE_REFERENCE_FIELDS.map((field) => [field, fileId()]));
      const row: Record<string, unknown> = {};
      for (const field of FILE_REFERENCE_FIELDS) {
        row[field] =
          field === 'images' || field === 'photos'
            ? [{ fileId: ids[field], position: 0 }]
            : ids[field];
      }
      for (const entityType of FILE_REFERENCE_ENTITY_TYPES) {
        const [answer] = await requireSuite(suite).client<{ ids: string[] }[]>`
          select moovo_entity_file_ids(${entityType}, ${JSON.stringify(row)}::jsonb) as ids
        `;
        const expected = ENTITY_FILE_SLOTS[entityType].slots.map((slot) => ids[slot.field]).sort();
        expect({ entityType, ids: answer?.ids }).toEqual({ entityType, ids: expected });
      }
    });

    it('raises for an entity type it was not taught, rather than answering "no files"', async () => {
      await expect(
        requireSuite(suite).client`select moovo_entity_file_ids('gallery', '{}'::jsonb)`,
      ).rejects.toThrow(/unknown entity type/);
    });
  });

  describe('the worker', () => {
    it('adds what a row uses and removes what it no longer does, then forgets both', async () => {
      const [kept, dropped] = [fileId(), fileId()];
      const storeId = await insertStore(dropped, kept);
      await db().update(stores).set({ logoFileId: null }).where(eq(stores.id, storeId));

      const { client, calls } = fakeOxy();
      setFileReferenceClientForTesting(client);
      const report = await runFileReferenceSyncBatch({
        leaseOwner: 'worker',
        leaseMs: 60_000,
        limit: 100,
        maxBackoffMs: 60_000,
      });

      expect(calls.add.flat()).toContainEqual({
        fileId: kept,
        entityType: 'store',
        entityId: storeId,
      });
      expect(calls.remove.flat()).toContainEqual({
        fileId: dropped,
        entityType: 'store',
        entityId: storeId,
      });
      expect(report.retried).toBe(0);
      expect(await pending(storeId)).toEqual([]);
    });

    it('completes an add Oxy refuses: asking again would change nothing', async () => {
      const storeId = await insertStore(fileId(), null);
      const { client } = fakeOxy({
        add: async (references) =>
          references.map((reference) => ({ ...reference, result: 'not_found' as const })),
      });
      setFileReferenceClientForTesting(client);
      const report = await runFileReferenceSyncBatch({
        leaseOwner: 'worker',
        leaseMs: 60_000,
        limit: 100,
        maxBackoffMs: 60_000,
      });
      expect(report.refused).toBeGreaterThanOrEqual(1);
      expect(await pending(storeId)).toEqual([]);
    });

    it('keeps the row, backs off and records why, when Oxy cannot be reached', async () => {
      const storeId = await insertStore(fileId(), null);
      const { client } = fakeOxy({
        add: async () => {
          throw new Error('503 from Oxy');
        },
      });
      setFileReferenceClientForTesting(client);
      const before = Date.now();
      await runFileReferenceSyncBatch({
        leaseOwner: 'worker',
        leaseMs: 60_000,
        limit: 100,
        maxBackoffMs: 60_000,
      });
      const [row] = await pending(storeId);
      expect(row?.lastError).toBe('503 from Oxy');
      expect(row?.leaseOwner).toBeNull();
      expect(row?.availableAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    });

    it('never deletes a request that arrived while the older one was being told', async () => {
      const logo = fileId();
      const storeId = await insertStore(logo, null);
      const [claimed] = await claimFileReferenceSyncs({
        leaseOwner: 'worker',
        leaseMs: 60_000,
        limit: 1,
      });
      expect(claimed?.entityId).toBe(storeId);

      // The owner changes their mind while Oxy is being told about the logo.
      await db().update(stores).set({ logoFileId: null }).where(eq(stores.id, storeId));

      if (!claimed) throw new Error('nothing claimed');
      expect(await completeFileReferenceSync(claimed, 'worker')).toBe(false);
      const [row] = await pending(storeId);
      expect(row?.generation).toBe(2);
      expect(row?.leaseOwner).toBeNull();
    });

    it('does not hand one row to two workers', async () => {
      await insertStore(fileId(), null);
      const [first, second] = await Promise.all([
        claimFileReferenceSyncs({ leaseOwner: 'a', leaseMs: 60_000, limit: 100 }),
        claimFileReferenceSyncs({ leaseOwner: 'b', leaseMs: 60_000, limit: 100 }),
      ]);
      const keys = [...(first ?? []), ...(second ?? [])].map(
        (row) => `${row.entityType}|${row.entityId}|${row.fileId}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    // `available_at` is stamped by the trigger from the DATABASE clock, in
    // microseconds; the worker's clock is JavaScript's, in milliseconds, and may
    // run behind it. A worker a minute behind stands for both, deterministically.
    describe('on a worker whose clock is behind the database’s', () => {
      const behind = () => new Date(Date.now() - 60_000);
      const batch = () =>
        runFileReferenceSyncBatch({
          leaseOwner: 'worker',
          leaseMs: 60_000,
          limit: 100,
          maxBackoffMs: 60_000,
          now: behind,
        });

      it('tells Oxy about a request no attempt has claimed yet at once', async () => {
        const logo = fileId();
        const storeId = await insertStore(logo, null);
        const { client, calls } = fakeOxy();
        setFileReferenceClientForTesting(client);

        await batch();
        expect(calls.add.flat().map((reference) => reference.fileId)).toContain(logo);
        expect(await pending(storeId)).toEqual([]);
      });

      it('tells Oxy at once about a request re-enqueued after a failed attempt', async () => {
        const logo = fileId();
        const storeId = await insertStore(logo, null);
        setFileReferenceClientForTesting(
          fakeOxy({
            add: async () => {
              throw new Error('503 from Oxy');
            },
          }).client,
        );
        await batch();
        expect((await pending(storeId))[0]?.attempts).toBe(1);

        // The owner removes the logo: new information, worth asking about now.
        await db().update(stores).set({ logoFileId: null }).where(eq(stores.id, storeId));
        const { client, calls } = fakeOxy();
        setFileReferenceClientForTesting(client);
        await batch();
        expect(calls.remove.flat().map((reference) => reference.fileId)).toContain(logo);
        expect(await pending(storeId)).toEqual([]);
      });

      it('still waits out a failed attempt’s backoff', async () => {
        const storeId = await insertStore(fileId(), null);
        setFileReferenceClientForTesting(
          fakeOxy({
            add: async () => {
              throw new Error('503 from Oxy');
            },
          }).client,
        );
        await batch();
        const { client, calls } = fakeOxy();
        setFileReferenceClientForTesting(client);
        const report = await batch();
        expect(calls.add.flat().filter((reference) => reference.entityId === storeId)).toEqual([]);
        expect(report.claimed).toBe(0);
        expect(await pending(storeId)).toHaveLength(1);
      });

      it('never claims a re-enqueued request another worker still holds', async () => {
        const storeId = await insertStore(fileId(), null);
        const [held] = await claimFileReferenceSyncs({
          leaseOwner: 'a',
          leaseMs: 60_000,
          limit: 100,
        });
        expect(held?.entityId).toBe(storeId);
        await db().update(stores).set({ logoFileId: fileId() }).where(eq(stores.id, storeId));

        const taken = await claimFileReferenceSyncs({
          leaseOwner: 'b',
          leaseMs: 60_000,
          limit: 100,
        });
        expect(
          taken.filter((row) => row.entityId === storeId && row.fileId === held?.fileId),
        ).toEqual([]);
      });
    });

    it('backs off 30 s doubling, capped', () => {
      expect(syncBackoffMs(1, 3_600_000)).toBe(30_000);
      expect(syncBackoffMs(3, 3_600_000)).toBe(120_000);
      expect(syncBackoffMs(30, 3_600_000)).toBe(3_600_000);
    });
  });

  describe('the inventory', () => {
    it('streams every (entity, file) pair, without losing files at a page boundary', async () => {
      const made: { entityId: string; fileId: string }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const images = [fileId(), fileId(), fileId()];
        const entityId = await insertListing(
          images.map((id, position) => ({ fileId: id, position })),
        );
        for (const id of images) made.push({ entityId, fileId: id });
      }
      const seen: { entityId: string; fileId: string }[] = [];
      for await (const item of streamEntityFileInventory('listing', 2)) seen.push(item);
      for (const pair of made) expect(seen).toContainEqual(pair);
    });
  });

  describe('the nightly reconciliation', () => {
    it('schedules every entity type, reconciles one per run and books the next night', async () => {
      const providerFile = fileId();
      await db()
        .insert(providers)
        .values({ key: `p-${uuidv7()}`, name: 'Carrier', logoFileId: providerFile });
      await db()
        .insert(categories)
        .values({ name: 'Boxes', slug: `boxes-${uuidv7()}` });

      const { client, calls } = fakeOxy();
      setFileReferenceClientForTesting(client);

      const now = new Date();
      const done = new Set<string>();
      for (let i = 0; i < FILE_REFERENCE_ENTITY_TYPES.length; i += 1) {
        const entityType = await runDueReconciliation(now);
        if (entityType) done.add(entityType);
      }
      expect([...done].sort()).toEqual([...FILE_REFERENCE_ENTITY_TYPES].sort());
      expect(await runDueReconciliation(now)).toBeNull();

      const provider = calls.reconcile.find((call) => call.entityType === 'provider');
      expect(provider?.items.map((item) => item.fileId)).toContain(providerFile);

      const [row] = await db()
        .select()
        .from(fileReferenceReconciliations)
        .where(eq(fileReferenceReconciliations.entityType, 'provider'));
      expect(row?.lastResult).toMatchObject({ entityType: 'provider', added: expect.any(Number) });
      expect(row?.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
      expect(row?.leaseOwner).toBeNull();
    });

    it('records a failed run and retries it sooner than tomorrow', async () => {
      await db()
        .update(fileReferenceReconciliations)
        .set({ nextRunAt: new Date(0) })
        .where(eq(fileReferenceReconciliations.entityType, 'store'));
      const { client } = fakeOxy({
        reconcile: async () => {
          throw new Error('409 RECONCILIATION_IN_PROGRESS');
        },
      });
      setFileReferenceClientForTesting(client);
      expect(await runDueReconciliation()).toBe('store');
      const [row] = await db()
        .select()
        .from(fileReferenceReconciliations)
        .where(eq(fileReferenceReconciliations.entityType, 'store'));
      expect(row?.lastError).toBe('409 RECONCILIATION_IN_PROGRESS');
      expect(row?.nextRunAt.getTime()).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000);
    });

    it('is due at the configured UTC hour, strictly after now', () => {
      expect(nextNightlyRun(new Date('2026-10-16T02:59:00Z'), 3).toISOString()).toBe(
        '2026-10-16T03:00:00.000Z',
      );
      expect(nextNightlyRun(new Date('2026-10-16T03:00:00Z'), 3).toISOString()).toBe(
        '2026-10-17T03:00:00.000Z',
      );
    });
  });
});

/**
 * Every statement this service issues against `moderation_outboxes`.
 *
 * The row IS the job, so three properties here are load-bearing and each would
 * "work" on every happy path written the obvious way.
 *
 * ## 1. The enqueue writes NOTHING when the row exists — structurally
 *
 * The source is an upsert with `$setOnInsert` only, and its comment is the
 * longest in the domain because Mongoose made that hard: `timestamps: true`
 * would either put `updatedAt` under two operators (which the server rejects,
 * aborting intake's whole transaction) or leave a `$set: { updatedAt }` that
 * turns a repeated enqueue into a real WRITE — taking a row lock the dispatcher
 * is concurrently holding, and blocking.
 *
 * `ON CONFLICT (id) DO NOTHING` writes nothing at all on a repeat: no tuple
 * version, no timestamp, no lock. Not because a flag was passed, but because
 * there is no update branch to write one. A repeated enqueue is ORDINARY — a
 * transaction retry, two concurrent duplicate submissions, a sweep re-deriving
 * an event — so this is the property the deterministic id exists to provide,
 * and `moderation.realdb.test.ts` pins it on `xmin` as well as `updated_at`,
 * because a careful `DO UPDATE` that set every column to its current value
 * would leave `updated_at` alone and still bump the tuple.
 *
 * ## 2. The claim is `FOR UPDATE SKIP LOCKED`, which the source could not be
 *
 * Mongo's `findOneAndUpdate` serialises every dispatcher onto one document at a
 * time. `SKIP LOCKED` lets N tasks drain the queue concurrently without ever
 * handing two of them the same row, and an expired lease stays reclaimable, so
 * a dead worker cannot strand moderation work.
 *
 * ## 3. THREE different row counts, and only one of them ported for free
 *
 * The source reads `modifiedCount` in `complete` and `fail` but `matchedCount`
 * in `renew`, and that difference is deliberate: two renewals inside the same
 * millisecond compute an IDENTICAL `leaseUntil`, so a renewal that legitimately
 * held its lease modifies nothing and `modifiedCount` would report failure.
 * Postgres has one number and it behaves like `matchedCount`, so `renew` ports
 * exactly. `complete` and `fail` always move `status` away from `processing`,
 * so the two counts coincide there — an argument, not a construction, which is
 * why the realdb suite calls each one TWICE.
 */

import { and, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { requireTransaction } from '../transactionGuard';
import { moderationOutboxes } from '../schema/moderation';

/** How long a processed row is kept — an audit trail, not state. */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;
export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];

/**
 * The payload, by kind.
 *
 * `decision` is `unknown` deliberately: it is stored whole as delivered and
 * parsed against the published contract by the worker that acts on it.
 * Validating it at write time would mean an event shape this deployment does
 * not recognise yet is refused at the door and retried until it dead-letters,
 * instead of being kept until the code catches up.
 */
export interface ModerationOutboxPayload {
  reportId?: string;
  eventId?: string;
  caseId?: string;
  decision?: unknown;
}

/** An outbox row, in the shape the dispatcher reads. */
export interface ModerationOutboxEvent {
  id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

type OutboxRow = typeof moderationOutboxes.$inferSelect;

function toEvent(row: OutboxRow): ModerationOutboxEvent {
  return {
    id: row.id,
    kind: row.kind as ModerationOutboxKind,
    payload: (row.payload ?? {}) as ModerationOutboxPayload,
    attempts: row.attempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Write the promise, in the CALLER's transaction.
 *
 * `requireTransaction` rather than a type, because `DatabaseOrTransaction` is a
 * union the root handle satisfies: a caller who simply forgets to pass the
 * transaction type-checks, commits on its own connection, and leaves a report
 * answered 201 with nothing owed to deliver it. See `db/transactionGuard.ts`.
 *
 * This is the ONLY writer that CREATES a row here — the dispatcher claims
 * existing ones and never inserts — so there is no second queue to drift.
 */
export async function enqueueModerationOutboxRow(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
    now?: Date;
  },
  db: DatabaseOrTransaction,
): Promise<string> {
  const tx = requireTransaction(db, `enqueueModerationOutboxRow('${input.eventId}')`);
  const now = input.now ?? new Date();
  await tx
    .insert(moderationOutboxes)
    .values({
      id: input.eventId,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      availableAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: moderationOutboxes.id });
  return input.eventId;
}

/**
 * Atomically claim one due event.
 *
 * Due means a `pending` row whose time has come, OR a `processing` row whose
 * lease has expired — the second is what stops a dead worker stranding work.
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what lets several dispatchers
 * run at once: a row another task is already claiming is stepped over rather
 * than waited on.
 */
export async function claimModerationOutboxRow(
  options: { leaseOwner: string; eventId?: string | undefined; now?: Date; leaseMs: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + options.leaseMs);
  const due = and(
    ...(options.eventId ? [eq(moderationOutboxes.id, options.eventId)] : []),
    or(
      and(eq(moderationOutboxes.status, 'pending'), lte(moderationOutboxes.availableAt, now)),
      and(eq(moderationOutboxes.status, 'processing'), lte(moderationOutboxes.leaseUntil, now)),
    ),
  );

  const [row] = await db
    .update(moderationOutboxes)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil,
      attempts: sql`${moderationOutboxes.attempts} + 1`,
      lastError: null,
    })
    .where(
      sql`${moderationOutboxes.id} = (
        select ${moderationOutboxes.id}
        from ${moderationOutboxes}
        where ${due}
        order by ${moderationOutboxes.createdAt} asc
        for update skip locked
        limit 1
      )`,
    )
    .returning();
  return row ? toEvent(row) : null;
}

/** The lease predicate every owner-checked transition shares. */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(moderationOutboxes.id, eventId),
    eq(moderationOutboxes.status, 'processing'),
    eq(moderationOutboxes.leaseOwner, leaseOwner),
    gt(moderationOutboxes.leaseUntil, now),
  );
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxRow(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(moderationOutboxes)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(eventId, leaseOwner, now));
  return (result.count ?? 0) === 1;
}

/**
 * Extend only a live lease still owned by this dispatcher.
 *
 * The count read here is the one the source deliberately spelled
 * `matchedCount`: two renewals inside one millisecond compute the same
 * `leaseUntil`, so a successful renewal can change nothing. Postgres' row count
 * is a MATCH count, so it answers correctly where a "did anything change"
 * reading would report a lost lease that was never lost.
 */
export async function renewModerationOutboxRow(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(moderationOutboxes)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)) })
    .where(ownedLease(eventId, leaseOwner, now));
  return (result.count ?? 0) === 1;
}

/** Release a failed claim with backoff, or stop. The CALLER decides which. */
export async function releaseModerationOutboxRow(
  input: {
    eventId: string;
    status: 'pending' | 'dead_letter';
    availableAt: Date;
    lastError: string;
  },
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .update(moderationOutboxes)
    .set({
      status: input.status,
      availableAt: input.availableAt,
      lastError: input.lastError,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.eventId, leaseOwner, now));
  return (result.count ?? 0) === 1;
}

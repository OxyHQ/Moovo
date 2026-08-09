/**
 * Every statement this service issues against `feedback`, in one module.
 *
 * The first repository of the Postgres port, so the shape it establishes is the
 * one the rest follow:
 *
 * - **`db: DatabaseOrTransaction = getDb()` is the LAST parameter.** Defaulted so
 *   an ordinary caller writes nothing, and accepted so a caller already inside
 *   `db.transaction(...)` can pass its handle and have this write commit with
 *   theirs. A repository that reached for `getDb()` itself would silently open a
 *   second connection and commit outside the caller's block — type-correct, and
 *   atomicity quietly gone.
 * - **The repository returns ROWS, never DTOs.** Serialization is the service's
 *   job, because the wire shape is a contract with clients and the row shape is
 *   a contract with the database; folding them together is what makes a column
 *   rename a breaking API change.
 * - **Ids are minted here, not by the database.** The id has to exist before the
 *   row is written so it can be returned and logged without a round trip, and a
 *   backfilled row keeps its original 24-char ObjectId hex — so the column has
 *   no default and both shapes are live permanently.
 */

import { and, count, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { feedback } from '../schema/engagement';

/** A `feedback` row exactly as stored. */
export type FeedbackRow = typeof feedback.$inferSelect;

/** What `insertFeedback` needs. `status` is not accepted: a submission starts `pending`. */
export interface NewFeedback {
  oxyUserId: string;
  type: string;
  rating?: number | undefined;
  message: string;
  email?: string | undefined;
  /**
   * The source stored a nested `metadata` object whose schema declared exactly
   * these three keys, so mongoose's strict mode dropped anything else. They are
   * three flat columns here, and the same three keys survive — a `jsonb` bag
   * would have widened what a client can persist, which is a change nobody
   * asked for in a table that takes free-form user input.
   */
  metadata?: Record<string, unknown> | undefined;
}

/** Read one of the three retained metadata keys, ignoring any other type. */
function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

/** Store one submission and return it. Starts in the `pending` review state. */
export async function insertFeedback(
  input: NewFeedback,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedbackRow> {
  const [row] = await db
    .insert(feedback)
    .values({
      id: uuidv7(),
      oxyUserId: input.oxyUserId,
      type: input.type,
      rating: input.rating ?? null,
      message: input.message,
      email: input.email ?? null,
      metadataPlatform: metadataString(input.metadata, 'platform'),
      metadataAppVersion: metadataString(input.metadata, 'appVersion'),
      metadataDeviceInfo: metadataString(input.metadata, 'deviceInfo'),
      status: 'pending',
    })
    .returning();

  if (row === undefined) {
    // An insert with no `onConflict` clause returns the row or throws, so this
    // is unreachable — but returning `undefined` up the stack as if it were a
    // stored row is the one outcome that would be silent.
    throw new Error('Inserting feedback returned no row.');
  }
  return row;
}

/**
 * One page of the user's own feedback, newest first.
 *
 * `id` breaks ties on `createdAt`. The source sorted on `createdAt` alone, and
 * with offset pagination that is a real defect rather than a cosmetic one: two
 * rows sharing a timestamp have no defined order between pages, so one can be
 * served twice and another never. It is a strict addition — it only decides
 * cases the source left arbitrary — and `id` is unique, so the order is total.
 */
export async function listFeedbackForUser(
  oxyUserId: string,
  page: { limit: number; offset: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedbackRow[]> {
  return await db
    .select()
    .from(feedback)
    .where(eq(feedback.oxyUserId, oxyUserId))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(page.limit)
    .offset(page.offset);
}

/**
 * How many the user has submitted, for the pagination envelope.
 *
 * Postgres answers `count(*)` as `bigint`, which postgres.js decodes as a
 * STRING — so `total + 1` would be string concatenation and `tsc` would not say
 * a word. drizzle's `count()` carries `.mapWith(Number)`, which is what makes
 * this a real number; `feedback.realdb.test.ts` pins that rather than trusting
 * a dependency's internals to stay put.
 */
export async function countFeedbackForUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(feedback)
    .where(eq(feedback.oxyUserId, oxyUserId));
  return row?.total ?? 0;
}

/**
 * One item, scoped to its owner.
 *
 * The ownership predicate is in the WHERE clause rather than checked after the
 * read: fetching by id and comparing afterwards is the same query one forgotten
 * `if` away from an IDOR, and it also leaks existence through timing.
 */
export async function findFeedbackForUser(
  oxyUserId: string,
  feedbackId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedbackRow | null> {
  const [row] = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.id, feedbackId), eq(feedback.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

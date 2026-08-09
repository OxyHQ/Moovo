/**
 * Feedback service — the user's submitted product feedback.
 *
 * All operations are scoped to `oxyUserId`. A submission is created in the
 * `pending` review state; the caller can list their own feedback history
 * (newest first, paginated) and read a single item back. Logic lives here; the
 * controller is thin and the SQL lives in `db/feedback/feedbackRepository`.
 */

import { FEEDBACK_STATUSES, FEEDBACK_TYPES } from '../db/schema/valueSets.js';
import {
  countFeedbackForUser,
  findFeedbackForUser,
  insertFeedback,
  listFeedbackForUser,
  type FeedbackRow,
} from '../db/feedback/feedbackRepository.js';
import { notFound } from '../lib/errors/error-codes.js';

/**
 * Derived from the schema's own tuples rather than restated as literal unions.
 *
 * Those tuples type the column AND render its CHECK constraint, so deriving
 * here means the wire type, the column type and the database constraint all
 * move together. The previous spelling wrote `'bug' | 'feature' | …` out by
 * hand, which is a second copy of a closed set — and a second copy is exactly
 * what `db/schema/valueSets.ts` exists to prevent.
 */
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** A single piece of feedback as returned on the wire. */
export interface FeedbackDTO {
  id: string;
  type: FeedbackType;
  rating?: number;
  message: string;
  email?: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

/** Body accepted by `create` (assignable from the parsed `feedbackSchema`). */
export interface CreateFeedbackInput {
  type: FeedbackType;
  rating?: number;
  message: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Serialize a stored row to the wire `FeedbackDTO`.
 *
 * The `!== null` checks are the port's one real behavioural trap here. Mongo
 * OMITTED an unset optional field, so `rating` and `email` were absent from the
 * document and absent from the JSON. Postgres returns them as `null`, and the
 * previous `!== undefined` test passes for `null` — so a straight translation
 * would have started emitting `{"rating": null}` where the API used to emit
 * nothing, for every submission without a rating. Nothing would have failed;
 * clients would just have begun receiving a field that had never existed.
 */
function toDTO(row: FeedbackRow): FeedbackDTO {
  const dto: FeedbackDTO = {
    id: row.id,
    type: row.type as FeedbackType,
    message: row.message,
    status: row.status as FeedbackStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.rating !== null) dto.rating = row.rating;
  if (row.email !== null) dto.email = row.email;
  return dto;
}

/** Create a feedback submission for the user (starts in the `pending` state). */
export async function create(
  oxyUserId: string,
  input: CreateFeedbackInput,
): Promise<FeedbackDTO> {
  const row = await insertFeedback({
    oxyUserId,
    type: input.type,
    rating: input.rating,
    message: input.message,
    email: input.email,
    metadata: input.metadata,
  });
  return toDTO(row);
}

/** List the user's feedback history (newest first, offset-paginated). */
export async function list(
  oxyUserId: string,
  opts: { page: number; limit: number },
): Promise<{ data: FeedbackDTO[]; total: number }> {
  const { page, limit } = opts;
  const [rows, total] = await Promise.all([
    listFeedbackForUser(oxyUserId, { limit, offset: (page - 1) * limit }),
    countFeedbackForUser(oxyUserId),
  ]);
  return { data: rows.map(toDTO), total };
}

/** Read a single feedback item owned by the user, or throw NOT_FOUND. */
export async function getById(oxyUserId: string, feedbackId: string): Promise<FeedbackDTO> {
  const row = await findFeedbackForUser(oxyUserId, feedbackId);
  if (row === null) {
    throw notFound('Feedback not found');
  }
  return toDTO(row);
}

/**
 * Review service — verified-purchase reviews + rating aggregates.
 *
 * `createReview` gates on a qualifying prior order (you can only review what you
 * have purchased), enforces one review per buyer per target, recomputes the
 * target's rating aggregate INLINE (so the immediate read is correct) and also
 * enqueues a drift-proof recompute, then fires a best-effort `review_received`
 * notification to the target owner. `recomputeAggregate` derives + persists the
 * denormalized `{ rating, reviewCount }` onto the `Listing` / `Store` /
 * `SellerProfile`. `listReviews` returns a hydrated, paginated page.
 *
 * Cross-collection ids (`listingId`, `storeId`, `orderId`) are stored/queried as
 * `String`, consistent with the rest of the codebase.
 */

import type {
  CreateReviewInput,
  RatingAggregate,
  Review as ReviewDTO,
  ReviewAuthor,
  ReviewTargetType,
} from '@moovo/shared-types';
import {
  aggregateForTarget,
  findReviewByAuthorAndTarget,
  insertReview,
  listPublishedReviewsForTarget,
  targetColumnFor,
  type ReviewRow,
} from '../db/reviews/reviewRepository.js';
import {
  findOrderById,
  hasQualifyingPurchase,
  type OrderRecord,
  type PurchaseTarget,
} from '../db/commerce/orderRepository.js';
import { findListingById, setListingRating } from '../db/catalog/catalogRepository.js';
import { findStoreById, findStoreByHandle, setStoreRating } from '../db/stores/storeRepository.js';
import { setSellerRating } from '../db/stores/sellerProfileRepository.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia } from './media.service.js';
import { enqueueRecomputeAggregate } from '../queue/producers.js';
import { sendNotification } from '../lib/notification-service.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Order statuses that count as a completed/qualifying purchase for a review. */
const PURCHASED_STATUSES = ['paid', 'processing', 'shipped', 'delivered'] as const;

/** Average rating rounded to ONE decimal place. */
function roundRating(avg: number): number {
  return Math.round(avg * 10) / 10;
}

/** The persisted target-id field name for a target type. */
function targetIdField(targetType: ReviewTargetType): 'listingId' | 'storeId' | 'sellerOxyUserId' {
  switch (targetType) {
    case 'listing':
      return 'listingId';
    case 'store':
      return 'storeId';
    case 'seller':
      return 'sellerOxyUserId';
  }
}

/** Resolve + validate the required target id from the input for its target type. */
function resolveTargetId(input: CreateReviewInput): string {
  switch (input.targetType) {
    case 'listing':
      if (!input.listingId) throw validationError('listingId is required to review a listing');
      return input.listingId;
    case 'store':
      if (!input.storeId) throw validationError('storeId is required to review a store');
      return input.storeId;
    case 'seller':
      if (!input.sellerOxyUserId) {
        throw validationError('sellerOxyUserId is required to review a seller');
      }
      return input.sellerOxyUserId;
  }
}

/** True when the order matches the review target. */
function orderMatchesTarget(
  record: OrderRecord,
  input: CreateReviewInput,
  targetId: string,
): boolean {
  switch (input.targetType) {
    case 'listing':
      return record.items.some((item) => item.listingId === targetId);
    case 'store':
      return record.order.sellerType === 'store' && record.order.storeId === targetId;
    case 'seller':
      return (
        record.order.sellerType === 'user' && record.order.sellerOxyUserId === targetId
      );
  }
}

/** The named-order branch and the search branch must agree on what a target is. */
function purchaseTargetFor(input: CreateReviewInput, targetId: string): PurchaseTarget {
  switch (input.targetType) {
    case 'listing':
      return { kind: 'listing', listingId: targetId };
    case 'store':
      return { kind: 'store', storeId: targetId };
    case 'seller':
      return { kind: 'seller', sellerOxyUserId: targetId };
  }
}

/**
 * Assert the author has a qualifying purchase for the target. When `orderId` is
 * given, that specific order must belong to the author, be in a purchased state,
 * and match the target; otherwise any qualifying order is accepted.
 */
async function assertVerifiedPurchase(
  authorOxyUserId: string,
  input: CreateReviewInput,
  targetId: string,
): Promise<void> {
  if (input.orderId) {
    const record = await findOrderById(input.orderId);
    const qualifies =
      record !== null &&
      record.order.buyerOxyUserId === authorOxyUserId &&
      (PURCHASED_STATUSES as readonly string[]).includes(record.order.status) &&
      orderMatchesTarget(record, input, targetId);
    if (!qualifies) {
      throw forbidden('Order does not qualify for this review');
    }
    return;
  }

  const found = await hasQualifyingPurchase(
    authorOxyUserId,
    purchaseTargetFor(input, targetId),
    PURCHASED_STATUSES,
  );
  if (!found) {
    throw forbidden('You can only review items you have purchased');
  }
}

/** Build a `ReviewAuthor` from an Oxy profile (avatar resolved through the chokepoint). */
function toReviewAuthor(profile: OxyProfile | undefined): ReviewAuthor | undefined {
  if (!profile) {
    return undefined;
  }
  const author: ReviewAuthor = {
    displayName: profile.displayName,
    username: profile.username,
  };
  author.avatar = profile.avatar ? resolveMedia(profile.avatar) : (profile.avatar ?? null);
  return author;
}

/** Map a persisted review doc + the resolved author profile to the `Review` DTO. */
function toReviewDTO(doc: ReviewRow, authorProfiles: Map<string, OxyProfile>): ReviewDTO {
  const authorOxyUserId = String(doc.authorOxyUserId);
  const dto: ReviewDTO = {
    id: doc.id,
    authorOxyUserId,
    targetType: doc.targetType as ReviewTargetType,
    rating: doc.rating,
    status: doc.status as ReviewDTO['status'],
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  const author = toReviewAuthor(authorProfiles.get(authorOxyUserId));
  if (author) {
    dto.author = author;
  }
  if (doc.listingId) dto.listingId = String(doc.listingId);
  if (doc.storeId) dto.storeId = String(doc.storeId);
  if (doc.sellerOxyUserId) dto.sellerOxyUserId = String(doc.sellerOxyUserId);
  if (doc.orderId) dto.orderId = String(doc.orderId);
  if (doc.title) dto.title = doc.title;
  if (doc.body) dto.body = doc.body;
  return dto;
}

/**
 * Recompute a review target's `{ rating, reviewCount }` from its PUBLISHED
 * reviews and persist it onto the target model. Returns the new aggregate.
 */
export async function recomputeAggregate(
  targetType: ReviewTargetType,
  targetId: string,
): Promise<RatingAggregate> {
  const { average, count } = await aggregateForTarget(targetType, targetId);

  const reviewCount = count;
  const rating = count > 0 ? roundRating(average) : 0;

  switch (targetType) {
    case 'listing':
      await setListingRating(targetId, { rating, reviewCount });
      break;
    case 'store':
      await setStoreRating(targetId, { rating, reviewCount });
      break;
    case 'seller':
      await setSellerRating(targetId, { rating, reviewCount });
      break;
  }

  return { rating, reviewCount };
}

/**
 * Notify the target owner that a review was received (best-effort; never
 * throws). The author is never notified about their own review.
 */
async function notifyTargetOwner(
  doc: ReviewRow,
  input: CreateReviewInput,
  targetId: string,
  authorOxyUserId: string,
): Promise<void> {
  try {
    const recipients = new Set<string>();

    if (input.targetType === 'listing') {
      const listing = await findListingById(targetId);
      if (listing?.ownerType === 'user' && listing.oxyUserId) {
        recipients.add(listing.oxyUserId);
      } else if (listing?.ownerType === 'store' && listing.storeId) {
        const store = await findStoreById(listing.storeId);
        for (const member of store?.members ?? []) {
          if (member.role === 'owner') recipients.add(member.oxyUserId);
        }
      }
    } else if (input.targetType === 'store') {
      const store = await findStoreById(targetId);
      for (const member of store?.members ?? []) {
        if (member.role === 'owner') recipients.add(member.oxyUserId);
      }
    } else {
      recipients.add(targetId);
    }

    recipients.delete(authorOxyUserId);

    for (const userId of recipients) {
      await sendNotification({
        userId,
        type: 'review_received',
        title: 'New review',
        body: `You received a ${doc.rating}-star review.`,
        data: {
          reviewId: doc.id,
          targetType: input.targetType,
          rating: doc.rating,
        },
      });
    }
  } catch (err) {
    log.general.warn({ err, targetType: input.targetType }, 'review_received notification failed (best-effort)');
  }
}

/**
 * Create a review: verified-purchase gate → one-per-target → persist →
 * recompute aggregate (inline + enqueued backstop) → notify owner → return the
 * hydrated DTO.
 */
export async function createReview(
  authorOxyUserId: string,
  input: CreateReviewInput,
): Promise<ReviewDTO> {
  const targetId = resolveTargetId(input);

  await assertVerifiedPurchase(authorOxyUserId, input, targetId);

  const existing = await findReviewByAuthorAndTarget(authorOxyUserId, input.targetType, targetId);
  if (existing) {
    throw conflict('You have already reviewed this item');
  }

  // The insert answers a LISTING duplicate with null — the partial unique
  // index decides at commit time, so it also closes the race the pre-check
  // above cannot. Store and seller uniqueness has no index (same as the
  // source), so for those the pre-check IS the rule.
  const doc = await insertReview({
    authorOxyUserId,
    targetType: input.targetType,
    [targetColumnFor(input.targetType)]: targetId,
    rating: input.rating,
    status: 'published',
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.body ? { body: input.body } : {}),
  });
  if (doc === null) {
    throw conflict('You have already reviewed this item');
  }

  // Recompute the aggregate inline so the immediate read is correct.
  await recomputeAggregate(input.targetType, targetId);

  // Durable, drift-proof backstop. The inline recompute already ran, so a
  // producer throw here is non-fatal — log and continue.
  try {
    await enqueueRecomputeAggregate({ targetType: input.targetType, targetId });
  } catch (err) {
    log.general.warn({ err, targetType: input.targetType, targetId }, 'Failed to enqueue aggregate recompute');
  }

  await notifyTargetOwner(doc, input, targetId, authorOxyUserId);

  const authorProfiles = await getProfiles([authorOxyUserId]);
  return toReviewDTO(doc, authorProfiles);
}

/** Target descriptor for a review list. */
interface ReviewTarget {
  targetType: ReviewTargetType;
  targetId: string;
}

/** Offset-pagination parameters. */
interface ReviewListParams {
  page: number;
  limit: number;
}

/** A page of review DTOs plus the total matching count (controller paginates). */
interface ReviewPage {
  data: ReviewDTO[];
  total: number;
}

/**
 * List a target's PUBLISHED reviews (newest first), hydrating authors in ONE
 * batched `getProfiles` call. Returns the page + total count.
 */
export async function listReviews(
  { targetType, targetId }: ReviewTarget,
  { page, limit }: ReviewListParams,
): Promise<ReviewPage> {
  const { rows: docs, total } = await listPublishedReviewsForTarget(targetType, targetId, {
    page,
    limit,
  });

  const authorIds = [...new Set(docs.map((d) => d.authorOxyUserId))];
  const authorProfiles = await getProfiles(authorIds);

  return { data: docs.map((d) => toReviewDTO(d, authorProfiles)), total };
}

/**
 * List a store's reviews by its public handle. Resolves the store first (404 if
 * none), then delegates to {@link listReviews}.
 */
export async function listReviewsForStoreHandle(
  handle: string,
  pagination: ReviewListParams,
): Promise<ReviewPage> {
  const store = await findStoreByHandle(handle);
  if (!store) {
    throw notFound('Store not found');
  }
  return listReviews({ targetType: 'store', targetId: store.id }, pagination);
}

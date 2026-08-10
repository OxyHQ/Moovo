/**
 * `POST /reports` — the report surface.
 *
 * A 201 here means the report was STORED, and — when its type is deliverable —
 * that a durable promise to deliver it committed in the same transaction. It does
 * NOT mean CrowdSource accepted anything. CrowdSource may be unreachable,
 * mid-deploy or not yet configured, and the reporter is told their report was
 * received either way, because it was.
 *
 * The route accepts every type in the enum, including the ones with no subject
 * provider. Gating admission on the registry would make adopting CrowdSource a
 * breaking change for any report surface not yet wired up, and incremental
 * adoption one subject type at a time is the property that makes this
 * integration copyable — see `subjects/registry.ts`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isLiveEntityId } from '@oxyhq/db';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  type ReportReceiptDTO,
} from '@moovo/shared-types';
import { authenticateToken } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import {
  createReport,
  isDuplicateReportError,
} from '../services/moderation/report-intake.service.js';

const MAX_DETAILS_LENGTH = 2_000;

/**
 * At least one category, and no more than the enum holds.
 *
 * A report with no allegation is not a report — a jury handed one has no question
 * to answer — so an empty array is refused here rather than being turned into
 * `other.unclassifiable` further down, where the reporter could not be told.
 */
const createReportSchema = z.object({
  reportedType: z.enum(REPORTED_TYPES),
  reportedId: z.string().trim().min(1).max(200),
  categories: z.array(z.enum(REPORT_CATEGORIES)).min(1).max(REPORT_CATEGORIES.length),
  details: z.string().trim().max(MAX_DETAILS_LENGTH).optional(),
  /**
   * Validated as an id SHAPE only. Whether the reporter may attach this delivery
   * is an ownership question, answered server-side in the intake service — a
   * route-level check would be one more place that has to stay correct, and this
   * one is a security boundary rather than a formatting rule.
   */
  contextJobId: z.string().refine(isLiveEntityId, 'must be a valid id').optional(),
});

const router = Router();

router.use(authenticateToken);

router.post(
  '/',
  makeRateLimiter('reports'),
  validateBody(createReportSchema),
  async (req: Request, res: Response): Promise<void> => {
    const reporter = getRequiredOxyUserId(req);
    const input = createReportSchema.parse(req.body);

    try {
      const { report } = await createReport({
        reporter,
        reportedType: input.reportedType,
        reportedId: input.reportedId,
        categories: input.categories,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.contextJobId === undefined ? {} : { contextJobId: input.contextJobId }),
      });

      const receipt: ReportReceiptDTO = {
        id: report.id,
        reportedType: report.reportedType,
        reportedId: report.reportedId,
        status: report.status,
        localStatus: report.localStatus,
        ...(report.localStatusReason === undefined
          ? {}
          : { localStatusReason: report.localStatusReason }),
        createdAt: report.createdAt.toISOString(),
      };
      sendSuccess(res, receipt, 201);
    } catch (error: unknown) {
      /**
       * The unique index answered, not a pre-read.
       *
       * A `findOne` before the insert races two taps of the same button and both
       * pass it. Letting the index decide means the second submission is a 409
       * rather than a second case for one incident.
       */
      if (isDuplicateReportError(error)) {
        sendError(res, ErrorCodes.CONFLICT, 'You have already reported this.', 409);
        return;
      }
      log.moderation.error({ err: error, reporter }, 'Failed to create report');
      sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to submit report', 500);
    }
  },
);

export default router;

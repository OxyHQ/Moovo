/**
 * A reported delivery, as universal material.
 *
 * ## Why `custom.moovo.delivery` and not `commerce.listing`
 *
 * The standard subject types include `commerce.listing` and `commerce.review`,
 * and the pull toward reusing one is strong because Moovo's inherited marketplace
 * scaffolding still has both. It would be wrong. A listing is an OFFER — someone
 * publishing goods for sale to anyone who looks — and a jury handed a
 * `commerce.listing` reasons about it as published commercial content: is the
 * description misleading, is the item counterfeit, is the price a scam. A
 * delivery is none of those things. It is a private movement of an object between
 * two named people, most of whose material never had an audience at all.
 *
 * Forcing it into the commerce vocabulary would tell a jury the wrong thing about
 * what they are looking at, and the plan is explicit that a subject type an
 * application cannot honestly claim should be namespaced instead. That is what
 * `custom.<organization>.<object_type>` exists for, and a case landing in a custom
 * namespace is a signal worth reading rather than a default to avoid.
 *
 * The same reasoning governs the allegation codes: `commerce.prohibited_item`
 * genuinely describes shipping something that may not be shipped, so it is used;
 * "the courier drove dangerously" has no universal code and becomes
 * `other.policy_specific` rather than being bent into `integrity.*`. See
 * `report-taxonomy.ts`.
 *
 * ## The material is redacted before it is described
 *
 * Everything here goes through `delivery-context.ts` and therefore `redaction.ts`.
 * A Job document holds two contact names, two phone numbers, two street
 * addresses, two precise coordinate pairs and the delivery verification codes, and
 * none of it reaches a jury. Read `redaction.ts` for why each one is excluded.
 */

import { config } from '../../../config/index.js';
import { buildDeliveryResource, loadSnapshotJob } from './delivery-context.js';
import type {
  ModerationSnapshotContext,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

export function createDeliverySubjectProvider(input: {
  reportedType: string;
}): ModerationSubjectProvider {
  return {
    reportedType: input.reportedType,
    subjectType: 'custom.moovo.delivery',

    async snapshot(
      reportedId: string,
      _context: ModerationSnapshotContext,
    ): Promise<ModerationSubjectSnapshot | null> {
      const job = await loadSnapshotJob(reportedId);
      if (!job) return null;

      /**
       * The SENDER is the delivery's author.
       *
       * A delivery has two parties and only one of them brought it into
       * existence: the sender described the parcel, wrote the notes and chose
       * what to ship, so the sender is who authored the material a jury reads.
       * The courier's conduct during it is a separate allegation about a separate
       * subject — that is what the `courier` reported type is for, and conflating
       * them here would point a sanction about a prohibited item at whoever
       * happened to carry it.
       */
      return {
        subject: {
          externalId: job.id,
          type: 'custom.moovo.delivery',
          /**
           * The sender's own view of the delivery — `app/(app)/jobs/[id].tsx`,
           * the route that actually exists. Never fetched by a jury: a permalink
           * is where the application's own users see the object, and this one
           * renders nothing at all without their session.
           */
          permalink: `${config.web.origin}/jobs/${job.id}`,
          author: { oxyUserId: job.senderOxyUserId },
        },
        content: await buildDeliveryResource(job),
      };
    },
  };
}

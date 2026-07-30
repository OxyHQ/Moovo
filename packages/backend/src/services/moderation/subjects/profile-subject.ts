/**
 * A reported person — a courier or a customer — as universal material.
 *
 * One provider factory serves both nouns with a different `reportedType`, because
 * a courier and a customer are the same kind of object (an Oxy account) playing
 * different roles in a delivery. That is the shape a second application usually
 * finds too: one loader, several nouns.
 *
 * ## The material is the ACCOUNT; the delivery is the CONTEXT
 *
 * This is the difference between Moovo's integration and a social app's, and
 * getting it backwards produces cases no jury can answer. Reporting a Mention
 * post gives a jury the post — the material and the allegation are the same
 * object. Reporting a Moovo courier gives a jury a profile, and "was this courier
 * abusive" is not answerable from a display name and an avatar. The allegation is
 * about an ENCOUNTER.
 *
 * So the subject is the account (that is who a sanction would land on) and the
 * delivery travels as a context resource — redacted, and only when the intake
 * service confirmed the reporter was a party to it.
 *
 * ## What deliberately does NOT travel: Moovo's own aggregates
 *
 * `CourierProfile` holds `rating`, `reviewCount`, `completedJobs`, `cancelledJobs`
 * and `acceptanceRate`, and every one of them is tempting and wrong to send.
 *
 * Two independent reasons, either sufficient. First, §5.3's `profile.claims` are
 * what an account ASSERTS ABOUT ITSELF — a username, a website. A cancelled-job
 * count is a Moovo-computed aggregate, so shipping it as a claim would be Moovo
 * putting its own arithmetic in a jury's hands as though the courier had said it.
 * Second and more seriously, it is reputation, and telling a blind jury "this
 * courier has cancelled 40 deliveries" before they judge one encounter is
 * prejudice with a number attached — it invites them to decide the person rather
 * than the incident, which is the thing a randomly drawn jury exists to avoid.
 * Reputation is Oxy Trust's business and it consumes decisions; it must never
 * become an input to one.
 */

import { oxyClient } from '../../../middleware/auth.js';
import { log } from '../../../lib/logger.js';
import { buildDeliveryContext } from './delivery-context.js';
import { boundedText } from './redaction.js';
import type {
  ModerationContextResource,
  ModerationSnapshotContext,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/** §5.3 `profile.claims`: bounded, flat, scalar. */
const MAX_CLAIM_LENGTH = 200;

export function createProfileSubjectProvider(input: {
  reportedType: string;
}): ModerationSubjectProvider {
  return {
    reportedType: input.reportedType,
    subjectType: 'identity.profile',

    async snapshot(
      reportedId: string,
      context: ModerationSnapshotContext,
    ): Promise<ModerationSubjectSnapshot | null> {
      /**
       * `cache: false`: a jury must review the profile as it is NOW. The SDK's
       * five-minute GET cache would otherwise let a stale display name be the
       * thing that was reviewed — and a moderation snapshot is a
       * consistency-critical read by definition.
       */
      let user: Awaited<ReturnType<typeof oxyClient.getUserById>>;
      try {
        user = await oxyClient.getUserById(reportedId, { cache: false });
      } catch (error: unknown) {
        /**
         * An account that cannot be loaded is treated as gone rather than as an
         * outage, and the caller closes the report instead of retrying for days.
         * Logged at warn so a genuine Oxy outage is still visible: the
         * distinction between "deleted" and "unreachable" is not one this call
         * can make, and guessing "outage" would retry a deleted account forever.
         */
        log.moderation.warn(
          { err: error, oxyUserId: reportedId },
          '[CrowdSource] reported account could not be loaded',
        );
        return null;
      }
      if (!user) return null;

      const claim = (value: string | undefined): string | undefined =>
        boundedText(value, MAX_CLAIM_LENGTH);

      /**
       * `name.displayName` is read directly and never recomposed from
       * `first`/`last`/`full` or substituted from the username. What a jury judges
       * has to be what the account actually shows; a name this code assembled
       * would be evidence Moovo invented. A profile with no display name is
       * normal, and every field of §5.3's `profile` is optional for that reason.
       */
      const displayName = claim(user.name?.displayName);
      const bio = claim(user.description ?? user.bio);
      const username = claim(user.username);

      /** Claims, not evidence: what the account asserts about itself. */
      const claims: Record<string, string> = {};
      if (username !== undefined) claims.username = username;
      const website = claim(user.website);
      if (website !== undefined) claims.website = website;
      /**
       * The ROLE is a claim about this case, not about the account, and it is the
       * one piece of Moovo vocabulary a jury genuinely needs: "a courier was
       * abusive to a customer" and "a customer was abusive to a courier" are
       * different questions, and the profile resource is otherwise identical for
       * both.
       */
      claims.reportedRole = input.reportedType;

      const deliveryContext: ModerationContextResource[] = [];
      const delivery = await buildDeliveryContext(context.contextJobId);
      if (delivery) deliveryContext.push(delivery);

      return {
        subject: {
          externalId: reportedId,
          type: 'identity.profile',
          /**
           * No permalink. Moovo has no public profile page for a courier or a
           * customer — the apps show a courier only to the customer on their live
           * delivery — so any URL here would be invented, and a permalink that
           * 404s is worse than an absent one. It is optional precisely so nobody
           * has to make one up.
           */
          author: { oxyUserId: reportedId },
        },
        content: {
          type: 'profile',
          data: {
            ...(displayName === undefined ? {} : { displayName }),
            ...(bio === undefined ? {} : { bio }),
            claims,
          },
        },
        ...(deliveryContext.length > 0 ? { context: deliveryContext } : {}),
      };
    },
  };
}

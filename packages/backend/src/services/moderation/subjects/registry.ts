/**
 * Every noun Moovo can send for review, and the subject type each one is.
 *
 * Adding a subject type is one entry here plus one provider file. Nothing else in
 * the integration knows what a delivery is — not the outbox, not the delivery
 * worker, not the webhook receiver, not the enforcement service.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A reported type
 * WITHOUT one is still accepted by `POST /reports` and still stored — it simply
 * never leaves. The registry is not an admission gate on the API, and making it
 * one would mean every application breaks its own existing report surfaces on the
 * day it adopts CrowdSource. Incremental adoption, one subject type at a time, is
 * the property that makes this integration copyable at all.
 *
 * ## Why the marketplace nouns have no provider
 *
 * `listing`, `store` and `review` are LIVE routes in this deployment — Moovo was
 * forked from the Mercaria marketplace shell and still serves them — so a user
 * can see them and must be able to report them. They are also inherited
 * scaffolding that the courier/transport domain is replacing, which is the reason
 * they are accepted and recorded but deliberately not delivered:
 *
 * - Building a provider for a model scheduled for deletion means writing a
 *   subject type, a taxonomy mapping and an enforcement path that all get deleted
 *   with it, and in the meantime it competes with the real answer. Mercaria's own
 *   deployment reports `commerce.listing` and `commerce.review` under ITS
 *   credential, in ITS tenant, against models it is keeping.
 * - A report about one of them is not lost. It is stored with a reason saying why
 *   it went nowhere, which is exactly what a local-only report is for — and if
 *   the marketplace half survives longer than planned, adding a provider is one
 *   file and one line here.
 *
 * The honest cost is that a `received` report is a receipt for work nobody does,
 * and it is measured rather than hidden: `reconcileModerationReports` counts them
 * and must never re-queue one.
 */

import { createDeliverySubjectProvider } from './delivery-subject.js';
import { createProfileSubjectProvider } from './profile-subject.js';
import type { ModerationSubjectProvider } from './types.js';

const PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  // A courier and a customer are the same kind of object — an Oxy account —
  // playing different roles in a delivery. One loader, two nouns; the role
  // travels as a claim so a jury knows which question it is being asked.
  createProfileSubjectProvider({ reportedType: 'courier' }),
  createProfileSubjectProvider({ reportedType: 'customer' }),
  createDeliverySubjectProvider({ reportedType: 'delivery' }),
]);

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  PROVIDERS.map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment.
 * `ReportIntakeService` asks before queueing a delivery and
 * `EvidenceSnapshotService` asks again when it builds one; a type this returns
 * `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can pin the set. That is not ceremony: the difference between
 * a delivered type and a local-only one is invisible in a 201, so registering a
 * provider — or forgetting to — is a change no response body would reveal. The
 * assertion makes widening the delivered surface a deliberate act with an
 * argument attached.
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}

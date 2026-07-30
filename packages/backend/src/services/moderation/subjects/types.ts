/**
 * The seam that makes this integration copyable.
 *
 * CrowdSource's side of the "don't design moderation around your own nouns"
 * problem is already solved — the Case Envelope knows nothing about a post, a
 * listing or a delivery, and `@oxyhq/crowdsource` composes one from a description
 * of the material. What is left for an application is a translation problem, and
 * this file is the whole of it:
 *
 *     "given one of MY nouns and its id, describe the material"
 *
 * Everything downstream — digests, resource ids, relations, principal bindings,
 * the binding proof, the policy version, privacy terms, the idempotency key, the
 * envelope itself — is composed by the SDK from that description and is IDENTICAL
 * for every application and every subject type. Adding a subject type is one file
 * implementing {@link ModerationSubjectProvider} plus one line in the registry;
 * nothing in the outbox, the delivery worker, the webhook receiver, the decision
 * worker or the enforcement service changes.
 *
 * Two rules keep it that way, and both are load-bearing rather than stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The types below are
 *    the SDK's own input types, re-exported unchanged. A provider that built an
 *    envelope would have to invent resource ids and principal refs, and the dedup
 *    key is computed over exactly those — two reporters describing one delivery
 *    would open two cases, and "one penalty per incident" would fail in production
 *    with nothing failing in a test.
 * 2. **A provider is pure translation with reads.** It fetches its own object and
 *    returns; it does not decide whether to deliver, what the allegation is, or
 *    what happens to the report. Those belong to callers that are shared.
 */

import type { ContextInput, ReportSubjectInput, ResourceInput } from '@oxyhq/crowdsource';

/**
 * The SDK's resource description, unchanged.
 *
 * Re-exported as a type alias so a provider imports the vocabulary from this seam
 * rather than from four places — but it IS the SDK's type, not a local
 * restatement. A resource type added to the contract becomes available to every
 * provider the moment the dependency is bumped.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/**
 * One reported object, described.
 *
 * `content` is required because a report with no material is a question a jury
 * cannot answer. An application that cannot produce the material for one of its
 * nouns should not register a provider for it — see the registry.
 */
export interface ModerationSubjectSnapshot {
  /** Identity, type and author of the reported object. */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly — for Moovo, the delivery a
   * conduct report is about. Context, not extra exposure: the reviewer's view
   * stays at the minimum that makes the question answerable.
   */
  readonly context?: readonly ModerationContextResource[];
}

/**
 * Extra material the REPORT carries, rather than the subject.
 *
 * Moovo needs this and a social app does not, which is why it is a parameter
 * rather than something a provider reads for itself. A reported courier is an
 * account, but the allegation is about an ENCOUNTER: "this courier, on this
 * delivery". The delivery id lives on the report, not on the courier, and the
 * intake service has already checked the reporter was a party to it — a provider
 * must never re-derive it, because a provider has no idea who is asking.
 */
export interface ModerationSnapshotContext {
  /** A job the reporter was verifiably a party to, or nothing. */
  readonly contextJobId?: string;
}

/**
 * Translates one of the application's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun: every reported courier is an
 * `identity.profile`, every reported delivery a `custom.moovo.delivery`. Keeping
 * it here means the registry can answer "what does this application report?"
 * without loading a single object.
 */
export interface ModerationSubjectProvider {
  /** The application's own name for the noun, as it arrives on a report. */
  readonly reportedType: string;
  /** The namespaced subject type, standard or `custom.<organization>.<object_type>`. */
  readonly subjectType: string;
  /**
   * Describes the object, or returns `null` when it no longer exists.
   *
   * `null` is not a failure. Content deleted between the report and its delivery
   * is ordinary, and it is the caller's job to decide what that means — a
   * provider that threw would make deletion look like an outage and be retried
   * for days.
   */
  snapshot(
    reportedId: string,
    context: ModerationSnapshotContext,
  ): Promise<ModerationSubjectSnapshot | null>;
}

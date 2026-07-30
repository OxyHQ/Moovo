/**
 * Moovo's report categories, translated into CrowdSource's universal taxonomy.
 *
 * The categories on the left are what a reporter picked in a Moovo app. The codes
 * on the right are ALLEGATIONS — what is claimed, never what is true. A jury
 * classifies the material itself and may confirm a different code entirely, and
 * nothing about this table shortens that.
 *
 * ## Why this is versioned
 *
 * Every decision records the policy version it was decided under, and this
 * mapping is upstream of that: change what `unsafe_conduct` means and two reports
 * filed a month apart are no longer the same allegation.
 * {@link REPORT_TAXONOMY_VERSION} is stamped into the report metadata so a case
 * can always be read back against the mapping that produced it. Bump it in the
 * same change that alters a row.
 *
 * ## Courier/transport is where the universal taxonomy runs out, and that is fine
 *
 * The eleven universal families were written with published content in mind, and
 * a courier platform's worst incidents are not content at all. Two rows use
 * `other.policy_specific`, which is a REAL code meaning "this is against the
 * reporting application's rules and the universal taxonomy has no name for it" —
 * not a shrug and not a fallback:
 *
 * - **`unsafe_conduct`** — dangerous driving, an unsafe handover, a courier who
 *   would not leave. The closest universal codes are `violence.threat` (a claim
 *   about intended harm, which a reporter clicking "unsafe" is usually not
 *   making) and `harassment.targeted_abuse` (a claim about a course of conduct
 *   toward a person). Alleging either would tell a jury the reporter claimed
 *   something stronger and more specific than they did.
 * - **`service_failure`** — did not arrive, marked delivered without delivering,
 *   abandoned the parcel. `integrity.fraud` is the tempting mapping and it is a
 *   claim about intent to deceive; most service failures are not that, and a
 *   fraud allegation carries consequences a late delivery should not.
 *
 * The rows that DO fit are used without hesitation, and `commerce.prohibited_item`
 * is the clearest of them: Moovo moves physical goods, and shipping something
 * that may not be shipped is precisely what that code describes. Using the
 * commerce FAMILY here is not the same as claiming a delivery is a
 * `commerce.listing` — see `delivery-subject.ts` for why the subject type is
 * namespaced while an allegation code is not.
 *
 * ## `theft_or_damage` maps to fraud, and that is a judgement worth stating
 *
 * A parcel that arrives broken and a parcel that never arrives because someone
 * kept it are one button in the UI, and they are different claims. It maps to
 * `integrity.fraud` because the reporter alleging theft is alleging intent, and a
 * jury that finds only damage will say so — whereas mapping to
 * `other.policy_specific` would understate a theft allegation and could route it
 * to a lighter review.
 */

import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import type { ReportCategory } from '@moovo/shared-types';

export const REPORT_TAXONOMY_VERSION = '2026.07';

const CATEGORY_TO_ALLEGATION: Readonly<Record<ReportCategory, TaxonomyCode>> = Object.freeze({
  prohibited_item: 'commerce.prohibited_item',
  unsafe_conduct: 'other.policy_specific',
  harassment: 'harassment.targeted_abuse',
  discrimination: 'hate.protected_targeting',
  threat: 'harassment.credible_threat',
  theft_or_damage: 'integrity.fraud',
  impersonation: 'integrity.impersonation',
  privacy: 'privacy.personal_information',
  service_failure: 'other.policy_specific',
  other: 'other.unclassifiable',
});

/**
 * The allegation codes for a report's categories, deduplicated and ORDERED.
 *
 * Order is not cosmetic. Ingress fingerprints the whole envelope to detect "same
 * external id, different body", so a list whose order depended on how a client
 * happened to send its categories would turn a legitimate outbox retry into a
 * permanent 409 — days later, as a report silently stuck in a queue. Sorting
 * makes the same report produce the same bytes every time.
 *
 * Deduplication matters more here than in a social app: `unsafe_conduct` and
 * `service_failure` both map to `other.policy_specific`, so a reporter ticking
 * both would otherwise send the same code twice.
 */
export function allegationsForCategories(
  categories: readonly ReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_ALLEGATION[category];
    // A category the map does not cover cannot silently become nothing: a report
    // with no allegation is not a report. `other.unclassifiable` is what the
    // universal taxonomy provides for exactly this.
    codes.add(code ?? 'other.unclassifiable');
  }
  return Array.from(codes).sort();
}

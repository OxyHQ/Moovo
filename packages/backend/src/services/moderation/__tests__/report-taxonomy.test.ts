/**
 * Moovo's categories, translated into the universal taxonomy.
 *
 * Two properties are load-bearing beyond "the map is right":
 *
 * - **Order and deduplication.** Ingress fingerprints the whole envelope to
 *   detect "same external id, different body", so a list whose order depended on
 *   how a client sent its categories would turn a legitimate outbox retry into a
 *   permanent 409 — silently, days later, as a report stuck in a queue.
 * - **Completeness.** A category that fell through the map would produce a report
 *   with no allegation, which is not a report.
 */

import { describe, it, expect } from 'vitest';
import { REPORT_CATEGORIES, type ReportCategory } from '@moovo/shared-types';
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from '../report-taxonomy.js';

describe('allegationsForCategories', () => {
  it('maps every category to a non-empty allegation', () => {
    // A vacuity floor as much as a mapping check: if `REPORT_CATEGORIES` were
    // ever emptied, the loop below would pass by running zero times.
    expect(REPORT_CATEGORIES.length).toBeGreaterThanOrEqual(10);
    for (const category of REPORT_CATEGORIES) {
      expect(allegationsForCategories([category])).toHaveLength(1);
    }
  });

  it('returns codes in a stable sorted order regardless of input order', () => {
    const forward = allegationsForCategories(['harassment', 'prohibited_item', 'privacy']);
    const reversed = allegationsForCategories(['privacy', 'prohibited_item', 'harassment']);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([...forward].sort());
  });

  it('deduplicates two categories that share one code', () => {
    // `unsafe_conduct` and `service_failure` both map to `other.policy_specific`,
    // so a reporter ticking both would otherwise send the same code twice.
    expect(allegationsForCategories(['unsafe_conduct', 'service_failure'])).toEqual([
      'other.policy_specific',
    ]);
  });

  describe('the mappings worth arguing about', () => {
    it('maps prohibited_item to the commerce code, which genuinely fits', () => {
      // Moovo moves physical goods; shipping something that may not be shipped is
      // precisely what this code describes.
      expect(allegationsForCategories(['prohibited_item'])).toEqual([
        'commerce.prohibited_item',
      ]);
    });

    it.each(['unsafe_conduct', 'service_failure'] as const)(
      'maps %s to other.policy_specific rather than bending it into integrity.*',
      (category) => {
        // The universal families were written with published content in mind. A
        // fraud allegation carries consequences a late delivery should not.
        expect(allegationsForCategories([category])).toEqual(['other.policy_specific']);
      },
    );

    it('maps theft_or_damage to fraud, because the reporter is alleging intent', () => {
      // A jury that finds only damage will say so; mapping to policy_specific
      // would understate a theft allegation.
      expect(allegationsForCategories(['theft_or_damage'])).toEqual(['integrity.fraud']);
    });

    it('maps threat to the credible-threat code, not to generic abuse', () => {
      expect(allegationsForCategories(['threat'])).toEqual(['harassment.credible_threat']);
    });
  });

  it('never returns an empty list for a non-empty input', () => {
    const unknown = 'a_category_from_a_newer_client' as ReportCategory;
    // A report with no allegation is not a report; `other.unclassifiable` is what
    // the universal taxonomy provides for exactly this.
    expect(allegationsForCategories([unknown])).toEqual(['other.unclassifiable']);
  });
});

describe('REPORT_TAXONOMY_VERSION', () => {
  it('is stamped so a case can be read back against the mapping that produced it', () => {
    expect(REPORT_TAXONOMY_VERSION).toMatch(/^\d{4}\.\d{2}$/);
  });
});

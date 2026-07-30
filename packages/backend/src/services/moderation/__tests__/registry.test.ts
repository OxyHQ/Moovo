/**
 * What Moovo sends for review, pinned.
 *
 * This assertion is not ceremony. The difference between a delivered type and a
 * local-only one is INVISIBLE in a 201 — both answer the reporter identically —
 * so registering a provider, or forgetting to, is a change no response body would
 * reveal and no other test would catch. Pinning the set makes widening the
 * delivered surface a deliberate act with an argument attached.
 */

import { describe, it, expect } from 'vitest';
import { REPORTED_TYPES } from '@moovo/shared-types';
import { deliverableTypes, subjectProviderFor } from '../subjects/registry.js';

describe('the delivered surface', () => {
  it('is exactly the live courier domain', () => {
    expect([...deliverableTypes()].sort()).toEqual(['courier', 'customer', 'delivery']);
  });

  it.each(['courier', 'customer'] as const)('reports a %s as identity.profile', (type) => {
    expect(subjectProviderFor(type)?.subjectType).toBe('identity.profile');
  });

  it('reports a delivery under a namespaced custom type', () => {
    /**
     * NOT `commerce.listing`. A listing is an offer published to anyone who
     * looks, and a jury handed one reasons about it as commercial content: is the
     * description misleading, is the item counterfeit. A delivery is a private
     * movement of an object between two named people. Forcing it into the
     * commerce vocabulary would tell a jury the wrong thing about what they are
     * looking at.
     */
    expect(subjectProviderFor('delivery')?.subjectType).toBe('custom.moovo.delivery');
  });

  it('uses a subject type the contract will accept', () => {
    // `custom.<organization>.<object_type>`, lowercase, exactly two dots. A typo
    // here fails envelope composition as a non-retryable input error — i.e. a
    // dead-lettered report — rather than anything visible at build time.
    expect(subjectProviderFor('delivery')?.subjectType).toMatch(
      /^custom\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/,
    );
  });
});

describe('the accepted-but-local-only surface', () => {
  it.each(['listing', 'store', 'review'] as const)(
    'accepts a %s but has no provider for it',
    (type) => {
      /**
       * Inherited Mercaria scaffolding that Moovo is removing. They are LIVE
       * routes today, so a user can see them and must be able to report them —
       * but building a provider for a model scheduled for deletion means writing
       * a subject type, a taxonomy mapping and an enforcement path that all get
       * deleted with it.
       */
      expect(REPORTED_TYPES).toContain(type);
      expect(subjectProviderFor(type)).toBeUndefined();
    },
  );

  it('leaves no reported type unaccounted for', () => {
    // Every enum member is either deliverable or deliberately local-only. A new
    // type added to the enum without a decision fails here rather than silently
    // becoming a report nobody ever looks at.
    const deliverable = new Set(deliverableTypes());
    const localOnly = new Set(['listing', 'store', 'review']);
    for (const type of REPORTED_TYPES) {
      expect(deliverable.has(type) || localOnly.has(type)).toBe(true);
    }
    expect(deliverable.size + localOnly.size).toBe(REPORTED_TYPES.length);
  });
});

describe('an unknown type', () => {
  it('has no provider, so it is stored and never enqueued', () => {
    expect(subjectProviderFor('a_noun_from_a_newer_client')).toBeUndefined();
  });
});

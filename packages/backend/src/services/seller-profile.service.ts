/**
 * Seller-profile service.
 *
 * Owns the lazy lifecycle + preference edits of an individual P2P seller's
 * marketplace profile, keyed by Oxy user id. Display identity (name/avatar) is
 * NEVER stored here — it is read live from Oxy at hydration time; this service
 * only manages the Moovo-owned aggregates and prefs.
 *
 * The two upserts are deliberately different shapes; see
 * `db/stores/sellerProfileRepository.ts` for why collapsing them to one
 * spelling silently discards every preference edit after the first.
 */

import {
  ensureSellerProfile,
  updateSellerPrefs,
  type SellerProfileRecord,
  type SellerPrefsPatch,
} from '../db/stores/sellerProfileRepository.js';

export type { SellerProfileRecord };

/** Editable shipping/return preferences. */
export type SellerPrefsInput = SellerPrefsPatch;

/**
 * Get the seller profile for `oxyUserId`, creating an empty one on first use
 * (lazy). Idempotent under concurrent first-writes.
 */
export async function getOrCreate(oxyUserId: string): Promise<SellerProfileRecord> {
  return ensureSellerProfile(oxyUserId);
}

/** Return the seller's own profile, creating it lazily if absent. */
export async function getMine(oxyUserId: string): Promise<SellerProfileRecord> {
  return ensureSellerProfile(oxyUserId);
}

/** Update the seller's shipping/return preferences (lazily creating the profile). */
export async function updatePrefs(
  oxyUserId: string,
  prefs: SellerPrefsInput,
): Promise<SellerProfileRecord> {
  return updateSellerPrefs(oxyUserId, prefs);
}

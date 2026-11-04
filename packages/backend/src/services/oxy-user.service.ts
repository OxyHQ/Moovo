/**
 * Oxy user batch-profile service.
 *
 * Resolves Oxy identities (displayName / username / avatar) for a set of user
 * ids in ONE batch and fail-soft: a user that fails to load is simply OMITTED
 * from the returned map and logged, so a single bad id never fails the whole
 * request. Display name is taken from the canonical
 * `user.name.displayName` contract — never recomputed.
 */

import { oxyClient } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

/** The minimal Oxy identity Moovo renders for a user. */
export interface OxyProfile {
  id: string;
  username: string;
  displayName: string;
  avatar?: string | null;
}

/**
 * Batch-load Oxy profiles for a set of user ids in one `users.lookupMany`
 * (chunked by the SDK). Fail-soft for rendering: an id Oxy does not return, or
 * whose chunk failed, is omitted, and a failure is logged — never remembered.
 * The returned map is keyed by the requested user id.
 */
export async function getProfiles(oxyUserIds: string[]): Promise<Map<string, OxyProfile>> {
  const map = new Map<string, OxyProfile>();
  const ids = oxyUserIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return map;

  const { found, failed, error } = await oxyClient.users.lookupMany(ids);
  if (failed.length > 0) {
    log.general.warn(
      { err: error, failed: failed.length },
      'Failed to load some Oxy profiles (omitting from batch)',
    );
  }
  for (const user of found) {
    map.set(user.id, {
      id: user.id,
      username: user.username,
      displayName: user.name.displayName,
      avatar: user.avatar,
    });
  }
  return map;
}

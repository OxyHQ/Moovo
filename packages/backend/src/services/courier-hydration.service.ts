/**
 * Courier hydration service.
 *
 * Turns raw `CourierProfileRow` documents into client-ready `Courier` DTOs, doing
 * the Oxy identity lookup in ONE batch (no N+1): batch-load every courier's Oxy
 * profile via `getProfiles`, then assemble each DTO with the Moovo-owned
 * aggregates + live Oxy identity. Display identity (name/avatar) is read LIVE
 * from Oxy, never stored on the courier profile.
 *
 * Media resolution funnels through the SINGLE sanctioned chokepoint
 * (`resolveMedia` from `media.service`) — do NOT define another.
 */

import type { Courier, TextTone } from '@moovo/shared-types';
import type { CourierProfileRow } from '../db/fleet/courierProfileRepository.js';
import type { CourierCompanyRecord } from '../db/fleet/courierCompanyRepository.js';
import { resolveMedia } from './media.service.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';

/** The PUBLIC presentational projection of a company (no member/permission data). */
export interface CompanySummary {
  id: string;
  handle: string;
  name: string;
  logoUrl?: string;
  coverImageUrl: string;
  brandColor: string;
  textTone: TextTone;
  rating: number;
  reviewCount: number;
  completedJobs: number;
}

/**
 * Build a `Courier` DTO from the courier profile aggregates + the Oxy identity.
 * If the Oxy profile is missing (failed to load), falls back to a minimal
 * courier (displayName = username = oxyUserId) so the request never breaks.
 */
export function toCourier(
  profile: CourierProfileRow,
  oxyProfile: OxyProfile | undefined,
): Courier {
  const oxyUserId = profile.oxyUserId;
  const courier: Courier = {
    id: profile.id,
    oxyUserId,
    displayName: oxyProfile?.displayName ?? oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    avatar: oxyProfile?.avatar ? resolveMedia(oxyProfile.avatar) : oxyProfile?.avatar ?? null,
    status: profile.status as Courier['status'],
    onlineStatus: profile.onlineStatus as Courier['onlineStatus'],
    eligibleJobTypes: [...profile.eligibleJobTypes] as Courier['eligibleJobTypes'],
  };
  if (profile.reviewCount > 0) {
    courier.rating = profile.rating;
    courier.reviewCount = profile.reviewCount;
  }
  return courier;
}

/**
 * Build the PUBLIC `CompanySummary` projection of a company. Logo/cover are
 * resolved through the media chokepoint.
 */
export function toCompanySummary(company: CourierCompanyRecord): CompanySummary {
  const summary: CompanySummary = {
    id: company.id,
    handle: company.handle,
    name: company.name,
    coverImageUrl: company.coverFileId ? resolveMedia(company.coverFileId) : '',
    brandColor: company.brandColor,
    textTone: company.textTone as TextTone,
    rating: company.rating,
    reviewCount: company.reviewCount,
    completedJobs: company.completedJobs,
  };
  if (company.logoFileId) {
    summary.logoUrl = resolveMedia(company.logoFileId);
  }
  return summary;
}

/**
 * Hydrate raw courier-profile docs into client-ready `Courier` DTOs with a
 * single batched Oxy identity lookup. Preserves input order.
 */
export async function hydrateCouriers(profiles: CourierProfileRow[]): Promise<Courier[]> {
  if (profiles.length === 0) {
    return [];
  }

  const oxyUserIds = [...new Set(profiles.map((p) => String(p.oxyUserId)))];
  const oxyProfiles = await getProfiles(oxyUserIds);

  return profiles.map((profile) => toCourier(profile, oxyProfiles.get(String(profile.oxyUserId))));
}

/**
 * Courier hydration service.
 *
 * Turns raw `ICourierProfile` documents into client-ready `Courier` DTOs, doing
 * the Oxy identity lookup in ONE batch (no N+1): batch-load every courier's Oxy
 * profile via `getProfiles`, then assemble each DTO with the Moovo-owned
 * aggregates + live Oxy identity. Display identity (name/avatar) is read LIVE
 * from Oxy, never stored on the courier profile.
 *
 * Media resolution funnels through the SINGLE sanctioned chokepoint
 * (`resolveMedia` from `catalog-hydration.service`) — do NOT define another.
 */

import mongoose from 'mongoose';
import type { Courier, TextTone } from '@moovo/shared-types';
import type { ICourierProfile } from '../models/courier-profile.js';
import type { ICompany } from '../models/courier-company.js';
import { resolveMedia } from './catalog-hydration.service.js';
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
  profile: ICourierProfile,
  oxyProfile: OxyProfile | undefined,
): Courier {
  const oxyUserId = String(profile.oxyUserId);
  const courier: Courier = {
    id: String((profile as { _id: mongoose.Types.ObjectId })._id),
    oxyUserId,
    displayName: oxyProfile?.displayName ?? oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    avatar: oxyProfile?.avatar ? resolveMedia(oxyProfile.avatar) : oxyProfile?.avatar ?? null,
    status: profile.status,
    onlineStatus: profile.onlineStatus,
    eligibleJobTypes: [...profile.eligibleJobTypes],
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
export function toCompanySummary(company: ICompany): CompanySummary {
  const summary: CompanySummary = {
    id: String((company as { _id: mongoose.Types.ObjectId })._id),
    handle: company.handle,
    name: company.name,
    coverImageUrl: company.coverFileId ? resolveMedia(company.coverFileId) : '',
    brandColor: company.brandColor,
    textTone: company.textTone,
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
export async function hydrateCouriers(profiles: ICourierProfile[]): Promise<Courier[]> {
  if (profiles.length === 0) {
    return [];
  }

  const oxyUserIds = [...new Set(profiles.map((p) => String(p.oxyUserId)))];
  const oxyProfiles = await getProfiles(oxyUserIds);

  return profiles.map((profile) => toCourier(profile, oxyProfiles.get(String(profile.oxyUserId))));
}

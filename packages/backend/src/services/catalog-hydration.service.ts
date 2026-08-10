/**
 * Catalog hydration service.
 *
 * Turns `ListingRecord`s into fully-hydrated `Listing` DTOs ready for the
 * client, doing ALL PostgreSQL + Oxy lookups in BATCHES (no N+1):
 *   1. batch-load every listing's variants,
 *   2. batch-load seller profiles (user listings) and stores (store listings),
 *   3. batch-load every owning user's Oxy profile in one `getProfiles` call,
 *   4. assemble each DTO with derived price fields + owner identity + media.
 *
 * Media resolution is funneled through ONE chokepoint (`resolveMedia`): absolute
 * URLs pass through unchanged (e.g. seeded Shopify CDN assets), everything else
 * is treated as an Oxy media file id and resolved via `getFileDownloadUrl` — the
 * only sanctioned media resolver.
 *
 * ## This is the ONE hydration path, and that is the point
 *
 * It reads listings, variants, seller profiles and stores — four entities, one
 * store. A second projection kept in step with this one by hand is precisely
 * the failure the port exists to remove, so callers that hold a listing from
 * anywhere else convert it to a `ListingRecord` rather than growing a parameter
 * here.
 */

import type { OxyServices } from '@oxyhq/core';
import type {
  Listing,
  ListingImage,
  ListingOption,
  Money,
  MerchantSummary,
  ProductThumbnail,
  ProductVariantDTO,
  Seller,
  TextTone,
} from '@moovo/shared-types';
import { listVariantsForListings } from '../db/catalog/catalogRepository.js';
import {
  toProductVariantRecord,
  type CatalogMoney,
  type ListingImageValue,
  type ListingRecord,
  type ProductVariantRecord,
} from '../db/catalog/catalogShape.js';
import { findSellerProfilesByUserIds, type SellerProfileRecord } from '../db/stores/sellerProfileRepository.js';
import { findStoresByIds } from '../db/stores/storeRepository.js';
import { config } from '../config/index.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia } from './media.service.js';

/** Map a stored money pair to the `Money` DTO. */
function toMoney(value: CatalogMoney): Money {
  return { amount: value.amount, currency: value.currency as Money['currency'] };
}

/** Map an internal variant to the wire `ProductVariantDTO` (never exposes `committed`). */
function toVariantDTO(variant: ProductVariantRecord): ProductVariantDTO {
  const available = variant.inventory.available;
  const inStock = !variant.inventory.tracked || available > 0;
  const dto: ProductVariantDTO = {
    id: variant.id,
    title: variant.title,
    optionValues: variant.optionValues.map((o) => ({ name: o.name, value: o.value })),
    price: toMoney(variant.price),
    available,
    inStock,
  };
  if (variant.sku) {
    dto.sku = variant.sku;
  }
  if (variant.compareAtPrice) {
    dto.compareAtPrice = toMoney(variant.compareAtPrice);
  }
  return dto;
}

/** Pick the variant with the lowest price (stable on ties by array order). */
function cheapestVariant(variants: ProductVariantRecord[]): ProductVariantRecord | undefined {
  return variants.reduce<ProductVariantRecord | undefined>((min, v) => {
    if (!min || v.price.amount < min.price.amount) {
      return v;
    }
    return min;
  }, undefined);
}

/** Map listing images through the media chokepoint into `ListingImage` DTOs. */
function toImageDTOs(images: ListingImageValue[]): ListingImage[] {
  return [...images]
    .sort((a, b) => a.position - b.position)
    .map((img) => {
      const dto: ListingImage = { fileId: resolveMedia(img.fileId), position: img.position };
      if (img.alt) {
        dto.alt = img.alt;
      }
      return dto;
    });
}

/**
 * Build a `Seller` DTO from the seller profile aggregates + the Oxy identity.
 * If the Oxy profile is missing (failed to load), falls back to a minimal seller
 * (displayName = username = oxyUserId) so the request never breaks.
 */
function toSeller(
  oxyUserId: string,
  profile: SellerProfileRecord | undefined,
  oxyProfile: OxyProfile | undefined,
): Seller {
  const seller: Seller = {
    id: profile ? profile.id : oxyUserId,
    oxyUserId,
    displayName: oxyProfile?.displayName ?? oxyUserId,
    username: oxyProfile?.username ?? oxyUserId,
    avatar: oxyProfile?.avatar ? resolveMedia(oxyProfile.avatar) : oxyProfile?.avatar ?? null,
    isVerified: profile?.isVerified ?? false,
  };
  if (profile && profile.reviewCount > 0) {
    seller.rating = profile.rating;
    seller.reviewCount = profile.reviewCount;
  }
  return seller;
}

/**
 * The store fields a merchant summary is built from.
 *
 * Structural rather than `StoreRecord` because it is a PROJECTION, not a store
 * reader: it names the fields a merchant card needs and nothing else, so a
 * caller cannot quietly start depending on a store's members or policies
 * through it.
 */
export interface MerchantSummarySource {
  id: string;
  handle: string;
  name: string;
  logoFileId?: string;
  coverFileId?: string;
  brandColor: string;
  rating: number;
  reviewCount: number;
  textTone: TextTone;
}

/**
 * Build the PUBLIC `MerchantSummary` projection of a store. `products` are a few
 * `ProductThumbnail`s drawn from the store's listings' images.
 */
export function toMerchantSummary(
  store: MerchantSummarySource,
  featuredListings: ListingRecord[],
): MerchantSummary {
  const products: ProductThumbnail[] = featuredListings
    .slice(0, config.feed.storeCardThumbnails)
    .map((listing) => {
      const firstImage = [...listing.images].sort((a, b) => a.position - b.position)[0];
      return {
        id: listing.id,
        title: listing.title,
        imageUrl: firstImage ? resolveMedia(firstImage.fileId, 'thumb') : '',
      };
    });

  const summary: MerchantSummary = {
    id: store.id,
    handle: store.handle,
    name: store.name,
    coverImageUrl: store.coverFileId ? resolveMedia(store.coverFileId) : '',
    brandColor: store.brandColor,
    rating: store.rating,
    reviewCount: store.reviewCount,
    textTone: store.textTone,
    products,
  };
  if (store.logoFileId) {
    summary.logoUrl = resolveMedia(store.logoFileId);
  }
  return summary;
}

/** Options for hydrating listings. */
export interface HydrateOptions {
  /** Reserved for future linked-client injection; defaults to the shared client. */
  oxyClient?: OxyServices;
}

/**
 * Hydrate listing records into client-ready `Listing` DTOs with batched
 * PostgreSQL/Oxy lookups. Preserves input order.
 */
export async function hydrateListings(
  listingRecords: ListingRecord[],
  _opts: HydrateOptions = {},
): Promise<Listing[]> {
  if (listingRecords.length === 0) {
    return [];
  }

  const listingIds = listingRecords.map((l) => l.id);

  // 1. Batch-load every variant for every listing, grouped by listingId. The
  //    repository already orders by (listingId, position, id), so the buckets
  //    come out in presentation order without a second sort.
  const variantRows = await listVariantsForListings(listingIds);
  const variantsByListing = new Map<string, ProductVariantRecord[]>();
  for (const row of variantRows) {
    const variant = toProductVariantRecord(row);
    const bucket = variantsByListing.get(variant.listingId);
    if (bucket) {
      bucket.push(variant);
    } else {
      variantsByListing.set(variant.listingId, [variant]);
    }
  }

  // 2. Split by ownerType; batch-load seller profiles and stores.
  const userOwnerIds = [
    ...new Set(
      listingRecords
        .filter((l) => l.ownerType === 'user' && l.oxyUserId !== undefined)
        .map((l) => l.oxyUserId as string),
    ),
  ];
  const storeIds = [
    ...new Set(
      listingRecords
        .filter((l) => l.ownerType === 'store' && l.storeId !== undefined)
        .map((l) => l.storeId as string),
    ),
  ];

  const [sellerProfiles, storeRecords] = await Promise.all([
    findSellerProfilesByUserIds(userOwnerIds),
    findStoresByIds(storeIds),
  ]);

  const sellerProfileByUser = new Map<string, SellerProfileRecord>();
  for (const p of sellerProfiles) {
    sellerProfileByUser.set(p.oxyUserId, p);
  }
  const storeById = new Map(storeRecords.map((s) => [s.id, s]));

  // 3. Batch-load all owning users' Oxy profiles in one call.
  const oxyProfiles = await getProfiles(userOwnerIds);

  // For each store, the listings it owns within THIS batch (for thumbnails).
  const listingsByStore = new Map<string, ListingRecord[]>();
  for (const l of listingRecords) {
    if (l.ownerType === 'store' && l.storeId !== undefined) {
      const bucket = listingsByStore.get(l.storeId);
      if (bucket) {
        bucket.push(l);
      } else {
        listingsByStore.set(l.storeId, [l]);
      }
    }
  }

  // 4. Assemble each DTO.
  return listingRecords.map((listing) => {
    const variants = variantsByListing.get(listing.id) ?? [];
    const variantDTOs = variants.map(toVariantDTO);
    const cheapest = cheapestVariant(variants);

    const priceFallback: Money = listing.priceRange
      ? toMoney(listing.priceRange.min)
      : { amount: 0, currency: 'USD' };
    const price = cheapest ? toMoney(cheapest.price) : priceFallback;
    const quantity = variants.reduce((sum, v) => sum + Math.max(0, v.inventory.available), 0);

    const options: ListingOption[] = listing.options.map((o) => ({
      name: o.name,
      values: [...o.values],
    }));

    const dto: Listing = {
      id: listing.id,
      ownerType: listing.ownerType,
      title: listing.title,
      description: listing.description,
      price,
      variants: variantDTOs,
      condition: listing.condition,
      status: listing.status,
      category: listing.categorySlugs[listing.categorySlugs.length - 1] ?? '',
      images: toImageDTOs(listing.images),
      tags: [...listing.tags],
      quantity,
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    };

    if (options.length > 0) {
      dto.options = options;
    }
    if (cheapest?.compareAtPrice) {
      dto.compareAtPrice = toMoney(cheapest.compareAtPrice);
    }
    if (variants.length > 0) {
      const amounts = variants.map((v) => v.price.amount);
      const currency = (cheapest ?? variants[0]).price.currency as Money['currency'];
      dto.priceRange = {
        min: { amount: Math.min(...amounts), currency },
        max: { amount: Math.max(...amounts), currency },
      };
    } else if (listing.priceRange?.max) {
      dto.priceRange = {
        min: toMoney(listing.priceRange.min),
        max: toMoney(listing.priceRange.max),
      };
    }

    if (listing.ownerType === 'user' && listing.oxyUserId !== undefined) {
      const oxyUserId = listing.oxyUserId;
      dto.seller = toSeller(oxyUserId, sellerProfileByUser.get(oxyUserId), oxyProfiles.get(oxyUserId));
    } else if (listing.ownerType === 'store' && listing.storeId !== undefined) {
      const store = storeById.get(listing.storeId);
      if (store) {
        dto.store = toMerchantSummary(store, listingsByStore.get(listing.storeId) ?? [listing]);
      }
    }

    return dto;
  });
}

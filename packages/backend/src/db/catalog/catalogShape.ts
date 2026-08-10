/**
 * The nested shapes the catalogue's consumers read, assembled from flat rows.
 *
 * Same division as `transport/shipmentShape.ts`: the schema keeps prices and
 * coordinates as separate columns so a CHECK or an index can reach either half,
 * and this file reassembles the objects the DTO builders are written against.
 *
 * ## The three jsonb columns are validated on the way out
 *
 * `images`, `options` and `optionValues` are `jsonb`, so the database
 * guarantees valid JSON and nothing more — the column cannot state that it
 * holds objects with a `fileId` and a numeric `position`. Reading them as that
 * shape unchecked is where a bad row becomes a confusing failure much later: a
 * `sort` comparing `undefined`, or the media chokepoint handed a number. Every
 * entry that is not the declared shape is therefore DROPPED rather than passed
 * on, and the caller receives a well-formed array or an empty one.
 *
 * Dropping rather than throwing is deliberate and matches `toPhotos`: one
 * malformed image should cost that image, not the whole product page.
 */

import type { ListingCondition, ListingOwnerType, ListingStatus } from '@moovo/shared-types';
import type { CategoryRow, ListingRow, ProductVariantRow } from './catalogRepository';

/** A stored listing image. */
export interface ListingImageValue {
  fileId: string;
  alt?: string;
  position: number;
}

/** A stored listing option (`{name, values[]}`). */
export interface ListingOptionValue {
  name: string;
  values: string[];
}

/** A stored variant option value (`{name, value}`). */
export interface VariantOptionValue {
  name: string;
  value: string;
}

/** A money pair as the catalogue's consumers read it. */
export interface CatalogMoney {
  amount: number;
  currency: string;
}

/**
 * A listing as the hydration path consumes it.
 *
 * `priceRange` is OPTIONAL and both-or-neither, mirroring
 * `listings_price_{min,max}_shape_check`: a listing with no variants has no
 * price range at all, and an absent range is not a zero one.
 */
export interface ListingRecord {
  id: string;
  ownerType: ListingOwnerType;
  oxyUserId?: string;
  storeId?: string;
  title: string;
  description: string;
  condition: ListingCondition;
  status: ListingStatus;
  categoryId?: string;
  categorySlugs: string[];
  images: ListingImageValue[];
  tags: string[];
  options: ListingOptionValue[];
  priceRange?: { min: CatalogMoney; max?: CatalogMoney };
  hasInventory: boolean;
  variantCount: number;
  rating: number;
  reviewCount: number;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** A buyable variant as the hydration path consumes it. */
export interface ProductVariantRecord {
  id: string;
  listingId: string;
  title: string;
  optionValues: VariantOptionValue[];
  sku?: string;
  price: CatalogMoney;
  compareAtPrice?: CatalogMoney;
  inventory: { tracked: boolean; available: number; committed: number };
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A taxonomy node as the category tree consumes it. */
export interface CategoryRecord {
  id: string;
  name: string;
  slug: string;
  parentId?: string;
  ancestorSlugs: string[];
  imageUrl?: string;
  imageFileId?: string;
  position: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The stored image array, validated. Malformed entries are dropped. */
export function toListingImages(raw: unknown): ListingImageValue[] {
  if (!Array.isArray(raw)) return [];
  const images: ListingImageValue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.fileId !== 'string' || typeof candidate.position !== 'number') continue;
    const image: ListingImageValue = { fileId: candidate.fileId, position: candidate.position };
    if (typeof candidate.alt === 'string') image.alt = candidate.alt;
    images.push(image);
  }
  return images;
}

/**
 * The stored option array, validated.
 *
 * `values` is filtered member-by-member rather than rejected wholesale: an
 * option carrying one non-string value still describes a real choice, and
 * dropping the whole option would remove a variant selector from the page.
 */
export function toListingOptions(raw: unknown): ListingOptionValue[] {
  if (!Array.isArray(raw)) return [];
  const options: ListingOptionValue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== 'string' || !Array.isArray(candidate.values)) continue;
    options.push({
      name: candidate.name,
      values: candidate.values.filter((v): v is string => typeof v === 'string'),
    });
  }
  return options;
}

/** The stored variant option values, validated. */
export function toVariantOptionValues(raw: unknown): VariantOptionValue[] {
  if (!Array.isArray(raw)) return [];
  const values: VariantOptionValue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== 'string' || typeof candidate.value !== 'string') continue;
    values.push({ name: candidate.name, value: candidate.value });
  }
  return values;
}

/**
 * Rebuild `priceRange` from the four flat columns.
 *
 * Absent when the minimum is absent — the CHECK pairs each amount with its
 * currency, so one non-null amount is enough to know the side is set. `max` is
 * independently optional because the source permits a range with only a floor.
 */
function toPriceRange(row: ListingRow): { min: CatalogMoney; max?: CatalogMoney } | undefined {
  if (row.priceMinAmount === null || row.priceMinCurrency === null) return undefined;
  const range: { min: CatalogMoney; max?: CatalogMoney } = {
    min: { amount: row.priceMinAmount, currency: row.priceMinCurrency },
  };
  if (row.priceMaxAmount !== null && row.priceMaxCurrency !== null) {
    range.max = { amount: row.priceMaxAmount, currency: row.priceMaxCurrency };
  }
  return range;
}

/** Assemble the record a hydration consumer reads from one flat listing row. */
export function toListingRecord(row: ListingRow): ListingRecord {
  const record: ListingRecord = {
    id: row.id,
    ownerType: row.ownerType as ListingOwnerType,
    title: row.title,
    description: row.description,
    condition: row.condition as ListingCondition,
    status: row.status as ListingStatus,
    categorySlugs: [...row.categorySlugs],
    images: toListingImages(row.images),
    tags: [...row.tags],
    options: toListingOptions(row.options),
    hasInventory: row.hasInventory,
    variantCount: row.variantCount,
    rating: row.rating,
    reviewCount: row.reviewCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.oxyUserId !== null) record.oxyUserId = row.oxyUserId;
  if (row.storeId !== null) record.storeId = row.storeId;
  if (row.categoryId !== null) record.categoryId = row.categoryId;
  if (row.publishedAt !== null) record.publishedAt = row.publishedAt;
  const priceRange = toPriceRange(row);
  if (priceRange !== undefined) record.priceRange = priceRange;
  return record;
}

/** Assemble the record a hydration consumer reads from one flat variant row. */
export function toProductVariantRecord(row: ProductVariantRow): ProductVariantRecord {
  const record: ProductVariantRecord = {
    id: row.id,
    listingId: row.listingId,
    title: row.title,
    optionValues: toVariantOptionValues(row.optionValues),
    price: { amount: row.priceAmount, currency: row.priceCurrency },
    inventory: {
      tracked: row.inventoryTracked,
      available: row.inventoryAvailable,
      committed: row.inventoryCommitted,
    },
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.sku !== null) record.sku = row.sku;
  if (row.compareAtAmount !== null && row.compareAtCurrency !== null) {
    record.compareAtPrice = { amount: row.compareAtAmount, currency: row.compareAtCurrency };
  }
  return record;
}

/** Assemble the record the category tree reads from one flat category row. */
export function toCategoryRecord(row: CategoryRow): CategoryRecord {
  const record: CategoryRecord = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ancestorSlugs: [...row.ancestorSlugs],
    position: row.position,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.parentId !== null) record.parentId = row.parentId;
  if (row.imageUrl !== null) record.imageUrl = row.imageUrl;
  if (row.imageFileId !== null) record.imageFileId = row.imageFileId;
  return record;
}

/**
 * Catalog write service — the SINGLE funnel for catalog mutations.
 *
 * Both the P2P seller path and the store-product path create/update listings
 * and their variants through here, so the denormalized listing facets
 * (`priceRange`, `hasInventory`, `variantCount`) ALWAYS stay in sync with the
 * variant table. `syncListingFacets` is the one place those facets are
 * recomputed and persisted; `inventory.service` re-uses it after stock changes
 * (no duplicate facet logic anywhere).
 *
 * P2P listings hide the variant model behind a flat `price`/`quantity` API: a
 * single Shopify-style "Default Title" variant is created. Store products take
 * an explicit `variants[]`.
 *
 * ## What the port changed, deliberately
 *
 * `listing.ts`'s `pre('validate')` hook is GONE, replaced by
 * `listings_owner_shape_check`. The hook ran on `create` and `save` and NOT on
 * the four `updateOne` paths, so the source could break the owner invariant
 * through an update and never notice; the CHECK covers every write. Nothing
 * re-implements the check in JavaScript — a read-then-write guard is a race,
 * and the constraint is what actually decides.
 */

import type {
  CreateP2PListingInput,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  Money,
  UpdateListingInput,
} from '@moovo/shared-types';
import {
  countVariants,
  deleteVariantRow,
  findCategoryBySlug,
  findListingById,
  insertListing,
  insertVariants,
  listVariantsForListing,
  updateListingFacets,
  updateListingRow,
  updateVariantRow,
  type ListingPatch,
  type NewProductVariant,
  type ProductVariantPatch,
} from '../db/catalog/catalogRepository.js';
import {
  toListingRecord,
  toProductVariantRecord,
  type ListingImageValue,
  type ProductVariantRecord,
} from '../db/catalog/catalogShape.js';
import { incrementStoreProductCount } from '../db/stores/storeRepository.js';
import { config } from '../config/index.js';
import { conflict, notFound, validationError } from '../lib/errors/error-codes.js';
import { getOrCreate as getOrCreateSellerProfile } from './seller-profile.service.js';

/** The default variant title for single-variant (P2P) listings. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/** Resolve a category slug to its id + denormalized `[ancestor..., slug]` path. */
async function resolveCategory(
  slug: string,
): Promise<{ categoryId: string; categorySlugs: string[] }> {
  const category = await findCategoryBySlug(slug);
  if (!category) {
    throw notFound(`Category not found: ${slug}`);
  }
  return {
    categoryId: category.id,
    categorySlugs: [...category.ancestorSlugs, category.slug],
  };
}

/** Map input image file ids to the persisted image shape. */
function toListingImages(imageFileIds: string[]): ListingImageValue[] {
  if (imageFileIds.length > config.catalog.maxImagesPerListing) {
    throw validationError(
      `A listing may have at most ${config.catalog.maxImagesPerListing} images`,
    );
  }
  return imageFileIds.map((fileId, position) => ({ fileId, position }));
}

/**
 * Recompute and persist a listing's denormalized facets from its variants:
 *  - `priceRange.min/max` from variant prices (single currency assumed),
 *  - `hasInventory` = any untracked variant OR any tracked variant with available>0,
 *  - `variantCount` = number of variants.
 *
 * Returns the up-to-date variants so callers avoid a re-query. Shared by the
 * write service and `inventory.service`.
 *
 * With no variants the price columns are set to NULL rather than zero: an
 * absent price is not a free one, and `listings_price_min_shape_check` pairs
 * each amount with its currency, so both halves move together.
 */
export async function syncListingFacets(listingId: string): Promise<ProductVariantRecord[]> {
  const variants = (await listVariantsForListing(listingId)).map(toProductVariantRecord);

  if (variants.length === 0) {
    await updateListingFacets(listingId, {
      priceMinAmount: null,
      priceMinCurrency: null,
      priceMaxAmount: null,
      priceMaxCurrency: null,
      hasInventory: false,
      variantCount: 0,
    });
    return variants;
  }

  const amounts = variants.map((v) => v.price.amount);
  const currency = variants[0].price.currency;
  const hasInventory = variants.some((v) => !v.inventory.tracked || v.inventory.available > 0);

  await updateListingFacets(listingId, {
    priceMinAmount: Math.min(...amounts),
    priceMinCurrency: currency,
    priceMaxAmount: Math.max(...amounts),
    priceMaxCurrency: currency,
    hasInventory,
    variantCount: variants.length,
  });

  return variants;
}

/**
 * Create a P2P (secondhand) listing owned by an individual user. Creates the
 * listing (`ownerType: 'user'`) plus a single Default-Title variant carrying
 * the price and `available = quantity ?? 1`. Lazily ensures the seller's
 * profile exists. Returns the new listing's id.
 */
export async function createP2PListing(
  oxyUserId: string,
  input: CreateP2PListingInput,
): Promise<string> {
  const { categoryId, categorySlugs } = await resolveCategory(input.category);
  await getOrCreateSellerProfile(oxyUserId);

  const quantity = input.quantity ?? 1;

  const listing = await insertListing({
    ownerType: 'user',
    oxyUserId,
    title: input.title,
    description: input.description,
    condition: input.condition,
    status: 'active',
    categoryId,
    categorySlugs,
    images: toListingImages(input.imageFileIds),
    tags: input.tags ?? [],
    options: [],
    priceMinAmount: input.price.amount,
    priceMinCurrency: input.price.currency,
    priceMaxAmount: input.price.amount,
    priceMaxCurrency: input.price.currency,
    hasInventory: quantity > 0,
    variantCount: 1,
    publishedAt: new Date(),
  });

  await insertVariants([
    {
      listingId: listing.id,
      title: DEFAULT_VARIANT_TITLE,
      optionValues: [],
      priceAmount: input.price.amount,
      priceCurrency: input.price.currency,
      inventoryTracked: true,
      inventoryAvailable: quantity,
      inventoryCommitted: 0,
      position: 0,
    },
  ]);

  await syncListingFacets(listing.id);
  return listing.id;
}

/** Human-readable variant title from its option-value tuple (e.g. `M / Black`). */
function variantTitleFromOptions(optionValues: { name: string; value: string }[]): string {
  if (optionValues.length === 0) {
    return DEFAULT_VARIANT_TITLE;
  }
  return optionValues.map((o) => o.value).join(' / ');
}

/**
 * Resolve the variants for a store product from the explicit `input.variants`.
 * Each variant carries its own option assignments, price, and inventory; the
 * `CreateStoreProductInput` contract requires at least one.
 */
function resolveStoreVariants(input: CreateStoreProductInput): Omit<NewProductVariant, 'listingId'>[] {
  if (input.variants.length === 0) {
    // No explicit variants: a store product MUST still produce at least one.
    throw validationError('A store product must include at least one variant');
  }

  return input.variants.map((v: CreateStoreProductVariantInput, position) => {
    const variant: Omit<NewProductVariant, 'listingId'> = {
      title: variantTitleFromOptions(v.optionValues),
      optionValues: v.optionValues.map((o) => ({ name: o.name, value: o.value })),
      priceAmount: v.price.amount,
      priceCurrency: v.price.currency,
      inventoryTracked: v.inventory.tracked ?? true,
      inventoryAvailable: v.inventory.available,
      inventoryCommitted: 0,
      position,
    };
    if (v.sku) {
      variant.sku = v.sku;
    }
    if (v.compareAtPrice) {
      variant.compareAtAmount = v.compareAtPrice.amount;
      variant.compareAtCurrency = v.compareAtPrice.currency;
    }
    return variant;
  });
}

/**
 * Create a store product. Creates the listing (`ownerType: 'store'`, with the
 * supplied selectable `options[]`) plus its variants, then increments the
 * store's `productCount`. Returns the new listing's id.
 */
export async function createStoreProduct(
  storeId: string,
  input: CreateStoreProductInput,
): Promise<string> {
  const { categoryId, categorySlugs } = await resolveCategory(input.category);
  const variants = resolveStoreVariants(input);

  if (variants.length > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  const first = variants[0];
  const listing = await insertListing({
    ownerType: 'store',
    storeId,
    title: input.title,
    description: input.description,
    condition: 'new',
    status: 'active',
    categoryId,
    categorySlugs,
    images: toListingImages(input.imageFileIds),
    tags: input.tags ?? [],
    options: input.options.map((o) => ({ name: o.name, values: [...o.values] })),
    priceMinAmount: first.priceAmount,
    priceMinCurrency: first.priceCurrency,
    priceMaxAmount: first.priceAmount,
    priceMaxCurrency: first.priceCurrency,
    hasInventory: false,
    variantCount: variants.length,
    publishedAt: new Date(),
  });

  await insertVariants(variants.map((v) => ({ ...v, listingId: listing.id })));

  await syncListingFacets(listing.id);
  await incrementStoreProductCount(storeId, 1);

  return listing.id;
}

/**
 * Update a listing's mutable fields (title, description, tags, status, images,
 * category). Price/quantity for P2P listings flow through the listing's single
 * variant. Recomputes facets afterwards. Returns nothing; callers re-hydrate
 * the listing for the response.
 */
export async function updateListing(
  listingId: string,
  patch: UpdateListingInput,
): Promise<void> {
  const row = await findListingById(listingId);
  if (!row) {
    throw notFound('Listing not found');
  }
  const listing = toListingRecord(row);

  const columns: ListingPatch = {};
  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.tags !== undefined) columns.tags = [...patch.tags];
  if (patch.condition !== undefined) columns.condition = patch.condition;
  if (patch.status !== undefined) {
    columns.status = patch.status;
    if (patch.status === 'active' && listing.publishedAt === undefined) {
      columns.publishedAt = new Date();
    }
  }
  if (patch.category !== undefined) {
    const { categoryId, categorySlugs } = await resolveCategory(patch.category);
    columns.categoryId = categoryId;
    columns.categorySlugs = categorySlugs;
  }
  if (patch.imageFileIds !== undefined) {
    columns.images = toListingImages(patch.imageFileIds);
  }

  // P2P price/quantity updates flow through the single variant, which is the
  // lowest-positioned one. Both are read from the same fetch rather than two.
  const p2pVariantPatch: ProductVariantPatch = {};
  if (patch.price !== undefined && listing.ownerType === 'user') {
    p2pVariantPatch.priceAmount = patch.price.amount;
    p2pVariantPatch.priceCurrency = patch.price.currency;
  }
  if (patch.quantity !== undefined && listing.ownerType === 'user') {
    p2pVariantPatch.inventoryAvailable = patch.quantity;
  }
  if (Object.keys(p2pVariantPatch).length > 0) {
    const [first] = await listVariantsForListing(listingId);
    if (first) {
      await updateVariantRow(listingId, first.id, p2pVariantPatch);
    }
  }

  await updateListingRow(listingId, columns);
  await syncListingFacets(listingId);
}

/** Archive a listing (soft-delete). Used by P2P DELETE and store DELETE. */
export async function archiveListing(listingId: string): Promise<void> {
  // `matchedCount` semantics: archiving an ALREADY-archived listing succeeds,
  // exactly as the source's `updateOne` did. A `status <> 'archived'` clause
  // here would turn a harmless repeat into a 404.
  const matched = await updateListingRow(listingId, { status: 'archived' });
  if (!matched) {
    throw notFound('Listing not found');
  }
}

/** Add a variant to a store product. Recomputes facets. Returns the variant id. */
export async function addVariant(
  listingId: string,
  input: CreateStoreProductVariantInput,
): Promise<string> {
  const listing = await findListingById(listingId);
  if (!listing) {
    throw notFound('Listing not found');
  }

  const existingCount = await countVariants(listingId);
  if (existingCount + 1 > config.catalog.maxVariantsPerProduct) {
    throw validationError(
      `A product may have at most ${config.catalog.maxVariantsPerProduct} variants`,
    );
  }

  const values: NewProductVariant = {
    listingId,
    title: variantTitleFromOptions(input.optionValues),
    optionValues: input.optionValues.map((o) => ({ name: o.name, value: o.value })),
    priceAmount: input.price.amount,
    priceCurrency: input.price.currency,
    inventoryTracked: input.inventory.tracked ?? true,
    inventoryAvailable: input.inventory.available,
    inventoryCommitted: 0,
    position: existingCount,
  };
  if (input.sku) {
    values.sku = input.sku;
  }
  if (input.compareAtPrice) {
    values.compareAtAmount = input.compareAtPrice.amount;
    values.compareAtCurrency = input.compareAtPrice.currency;
  }

  const [created] = await insertVariants([values]);

  await syncListingFacets(listingId);
  return created.id;
}

/** Fields accepted when updating a variant. */
export interface UpdateVariantInput {
  title?: string;
  sku?: string;
  price?: Money;
  compareAtPrice?: Money | null;
  optionValues?: { name: string; value: string }[];
  inventory?: { tracked?: boolean; available?: number };
}

/** Update a variant in place. Recomputes facets afterwards. */
export async function updateVariant(
  listingId: string,
  variantId: string,
  patch: UpdateVariantInput,
): Promise<void> {
  const columns: ProductVariantPatch = {};

  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.sku !== undefined) columns.sku = patch.sku;
  if (patch.price !== undefined) {
    columns.priceAmount = patch.price.amount;
    columns.priceCurrency = patch.price.currency;
  }
  if (patch.compareAtPrice !== undefined) {
    // Both halves move together — `product_variants_compare_at_shape_check`
    // refuses an amount without its currency.
    columns.compareAtAmount = patch.compareAtPrice === null ? null : patch.compareAtPrice.amount;
    columns.compareAtCurrency =
      patch.compareAtPrice === null ? null : patch.compareAtPrice.currency;
  }
  if (patch.optionValues !== undefined) {
    columns.optionValues = patch.optionValues.map((o) => ({ name: o.name, value: o.value }));
  }
  if (patch.inventory?.tracked !== undefined) {
    columns.inventoryTracked = patch.inventory.tracked;
  }
  if (patch.inventory?.available !== undefined) {
    columns.inventoryAvailable = patch.inventory.available;
  }

  const matched = await updateVariantRow(listingId, variantId, columns);
  if (!matched) {
    throw notFound('Variant not found');
  }
  await syncListingFacets(listingId);
}

/**
 * Remove a variant from a store product. A listing must always keep ≥1 variant,
 * so removing the last variant is rejected. Recomputes facets afterwards.
 */
export async function removeVariant(listingId: string, variantId: string): Promise<void> {
  const count = await countVariants(listingId);
  if (count <= 1) {
    throw conflict('A listing must keep at least one variant');
  }
  const deleted = await deleteVariantRow(listingId, variantId);
  if (!deleted) {
    throw notFound('Variant not found');
  }
  await syncListingFacets(listingId);
}

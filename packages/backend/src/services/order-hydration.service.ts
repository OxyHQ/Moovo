/**
 * Order hydration service.
 *
 * Turns `OrderRecord`s into client-ready `Order` / `OrderSummary` DTOs, doing
 * ALL Oxy + DB lookups in BATCHES (no N+1): for a list of orders it issues
 * exactly ONE `getProfiles` (distinct P2P seller ids), ONE
 * `findSellerProfilesByUserIds` and ONE `findStoresByIds`, then assembles each
 * DTO from the precomputed maps.
 *
 * Order line items are IMMUTABLE snapshots — they are mapped VERBATIM from the
 * persisted rows and NEVER re-read from the live catalog. This module is the
 * ONLY place order DTOs are built; controllers never hand-assemble order shapes.
 */

import type {
  Money,
  Order as OrderDTO,
  OrderItem,
  OrderStatus,
  OrderSummary,
  Seller,
  ShippingInfo,
  ShippingMethod,
  PaymentInfo,
  AddressSnapshot,
  OrderStatusEvent,
} from '@moovo/shared-types';
import type {
  OrderItemRow,
  OrderRecord,
  OrderRow,
  OrderStatusEventRow,
} from '../db/commerce/orderRepository.js';
import {
  findSellerProfilesByUserIds,
  type SellerProfileRecord,
} from '../db/stores/sellerProfileRepository.js';
import { findStoresByIds, type StoreRecord } from '../db/stores/storeRepository.js';
import { getProfiles, type OxyProfile } from './oxy-user.service.js';
import { resolveMedia } from './media.service.js';
import { toMerchantSummary } from './catalog-hydration.service.js';

/** Map a stored `{ amount, currency }` column pair to the `Money` DTO. */
function toMoney(amount: number, currency: string): Money {
  return { amount, currency: currency as Money['currency'] };
}

/**
 * Build a minimal `Seller` DTO from the seller profile aggregates + the Oxy
 * identity. Mirrors `catalog-hydration`'s (non-exported) `toSeller`: when the Oxy
 * profile is missing it falls back to a minimal seller (displayName = username =
 * oxyUserId) so the request never breaks.
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

/** Map a stored immutable line item snapshot to the `OrderItem` DTO (verbatim). */
export function toOrderItemDTO(item: OrderItemRow): OrderItem {
  const dto: OrderItem = {
    listingId: item.listingId,
    variantId: item.variantId,
    title: item.title,
    variantTitle: item.variantTitle,
    // `jsonb` reaches drizzle as `unknown`; the column is written only by
    // `insertOrder`, from `{name, value}` pairs.
    optionValues: ((item.optionValues ?? []) as { name: string; value: string }[]).map((o) => ({
      name: o.name,
      value: o.value,
    })),
    unitPrice: toMoney(item.unitPriceAmount, item.unitPriceCurrency),
    quantity: item.quantity,
    lineTotal: toMoney(item.lineTotalAmount, item.lineTotalCurrency),
  };
  if (item.imageUrl) {
    dto.imageUrl = item.imageUrl;
  }
  return dto;
}

/**
 * Rebuild the flattened `ship_to_*` columns into the `AddressSnapshot` DTO.
 * An absent optional stays ABSENT rather than becoming an empty string.
 */
function toAddressSnapshot(order: OrderRow): AddressSnapshot {
  const dto: AddressSnapshot = {
    recipientName: order.shipToRecipientName,
    line1: order.shipToLine1,
    city: order.shipToCity,
    postalCode: order.shipToPostalCode,
    country: order.shipToCountry,
  };
  if (order.shipToLabel) dto.label = order.shipToLabel;
  if (order.shipToLine2) dto.line2 = order.shipToLine2;
  if (order.shipToRegion) dto.region = order.shipToRegion;
  if (order.shipToPhone) dto.phone = order.shipToPhone;
  return dto;
}

/** Map the flattened shipping columns to the `ShippingInfo` DTO. */
function toShippingInfo(order: OrderRow): ShippingInfo {
  const dto: ShippingInfo = {
    method: order.shippingMethod as ShippingMethod,
    label: order.shippingLabel,
    cost: toMoney(order.shippingCostAmount, order.shippingCostCurrency),
  };
  if (order.trackingNumber) {
    dto.trackingNumber = order.trackingNumber;
  }
  return dto;
}

/** Map the flattened payment columns to the `PaymentInfo` DTO. */
function toPaymentInfo(order: OrderRow): PaymentInfo {
  const dto: PaymentInfo = {
    status: order.paymentStatus as PaymentInfo['status'],
    provider: order.paymentProvider as PaymentInfo['provider'],
  };
  if (order.paymentReference) {
    dto.reference = order.paymentReference;
  }
  if (order.paidAt) {
    dto.paidAt = order.paidAt.toISOString();
  }
  return dto;
}

/** Map a persisted status event row to the `OrderStatusEvent` DTO. */
function toStatusEvent(event: OrderStatusEventRow): OrderStatusEvent {
  const dto: OrderStatusEvent = {
    status: event.status as OrderStatus,
    at: event.at.toISOString(),
  };
  if (event.byOxyUserId) {
    dto.byOxyUserId = event.byOxyUserId;
  }
  if (event.note) {
    dto.note = event.note;
  }
  return dto;
}

/**
 * Batched lookup of the seller (P2P) + store identities referenced by a list of
 * orders: ONE `getProfiles`, ONE seller-profile read, ONE store read.
 */
async function loadSellerContext(records: OrderRecord[]): Promise<{
  oxyProfiles: Map<string, OxyProfile>;
  sellerProfileByUser: Map<string, SellerProfileRecord>;
  storeById: Map<string, StoreRecord>;
}> {
  const userSellerIds = [
    ...new Set(
      records
        .filter((r) => r.order.sellerType === 'user' && r.order.sellerOxyUserId)
        .map((r) => String(r.order.sellerOxyUserId)),
    ),
  ];
  const storeIds = [
    ...new Set(
      records
        .filter((r) => r.order.sellerType === 'store' && r.order.storeId)
        .map((r) => String(r.order.storeId)),
    ),
  ];

  const [sellerProfiles, stores, oxyProfiles] = await Promise.all([
    findSellerProfilesByUserIds(userSellerIds),
    findStoresByIds(storeIds),
    getProfiles(userSellerIds),
  ]);

  return {
    oxyProfiles,
    sellerProfileByUser: new Map(sellerProfiles.map((p) => [p.oxyUserId, p])),
    storeById: new Map(stores.map((s) => [s.id, s])),
  };
}

/**
 * Hydrate order records into client-ready `Order` DTOs with batched Oxy/DB
 * lookups. Serializes every `Date` to ISO-8601. Preserves order.
 */
export async function hydrateOrders(records: OrderRecord[]): Promise<OrderDTO[]> {
  if (records.length === 0) {
    return [];
  }

  const { oxyProfiles, sellerProfileByUser, storeById } = await loadSellerContext(records);

  return records.map(({ order, items, statusHistory }) => {
    const dto: OrderDTO = {
      id: order.id,
      orderNumber: order.orderNumber,
      buyerOxyUserId: order.buyerOxyUserId,
      sellerType: order.sellerType as OrderDTO['sellerType'],
      items: items.map(toOrderItemDTO),
      shippingAddress: toAddressSnapshot(order),
      shipping: toShippingInfo(order),
      totals: {
        subtotal: toMoney(order.subtotalAmount, order.subtotalCurrency),
        // `totals.shipping` and `shipping.cost` are ONE column pair — the
        // source stored the Money twice and assigned both from one variable,
        // so they cannot disagree. See the schema comment on
        // `shippingCostAmount`.
        shipping: toMoney(order.shippingCostAmount, order.shippingCostCurrency),
        grandTotal: toMoney(order.grandTotalAmount, order.grandTotalCurrency),
      },
      status: order.status as OrderStatus,
      statusHistory: statusHistory.map(toStatusEvent),
      payment: toPaymentInfo(order),
      checkoutGroupId: order.checkoutGroupId ?? '',
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = order.sellerOxyUserId;
      dto.sellerOxyUserId = oxyUserId;
      dto.seller = toSeller(
        oxyUserId,
        sellerProfileByUser.get(oxyUserId),
        oxyProfiles.get(oxyUserId),
      );
    } else if (order.sellerType === 'store' && order.storeId) {
      const storeId = order.storeId;
      dto.storeId = storeId;
      const store = storeById.get(storeId);
      if (store) {
        dto.store = toMerchantSummary(store, []);
      }
    }

    return dto;
  });
}

/**
 * Summarize order records into `OrderSummary` DTOs (buyer/seller list views),
 * with the same batched seller/store load as `hydrateOrders`. Preserves order.
 */
export async function summarizeOrders(records: OrderRecord[]): Promise<OrderSummary[]> {
  if (records.length === 0) {
    return [];
  }

  const { oxyProfiles, sellerProfileByUser, storeById } = await loadSellerContext(records);

  return records.map(({ order, items }) => {
    const summary: OrderSummary = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status as OrderStatus,
      grandTotal: toMoney(order.grandTotalAmount, order.grandTotalCurrency),
      // The sum of QUANTITIES, not of lines: counting rows is right for every
      // single-unit order and quietly wrong otherwise.
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      sellerType: order.sellerType as OrderSummary['sellerType'],
      createdAt: order.createdAt.toISOString(),
    };

    if (order.sellerType === 'user' && order.sellerOxyUserId) {
      const oxyUserId = order.sellerOxyUserId;
      summary.seller = toSeller(
        oxyUserId,
        sellerProfileByUser.get(oxyUserId),
        oxyProfiles.get(oxyUserId),
      );
    } else if (order.sellerType === 'store' && order.storeId) {
      const store = storeById.get(order.storeId);
      if (store) {
        summary.store = toMerchantSummary(store, []);
      }
    }

    return summary;
  });
}

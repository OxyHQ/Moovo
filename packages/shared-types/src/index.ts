/**
 * @moovo/shared-types
 *
 * TypeScript types shared between the Moovo frontend (`@moovo/frontend`)
 * and backend (`@moovo/backend`) to keep the API contract in one place.
 */

// Common API envelope, pagination and utility types.
export * from './common';

// Money DTO (inherited marketplace fiat money — retained until Phase 2).
export * from './money';

// FairCoin (FAIR) money contract — canonical Moovo money (FairMoney, DisplayMoney,
// FairRate, SupportedCurrency, FAIR_* constants).
export * from './fair-money';

// Seller DTO.
export * from './seller';

// Product variant DTO (ProductVariantDTO, VariantOptionValue).
export * from './variant';

// Listing domain entity, enums and request payloads.
export * from './listing';

// Product/merchant browse DTOs (ProductSummary, MerchantSummary, Category, CategoryPill).
export * from './product';

// Store (shop) admin-facing DTOs (Store, StoreMember, StoreRole, StorePermission).
export * from './store';

// Category taxonomy tree DTO (CategoryNode).
export * from './category';

// Cart DTOs (Cart, CartItemDTO, AddCartItemInput, UpdateCartItemInput).
export * from './cart';

// Address DTOs (Address, CreateAddressInput, UpdateAddressInput).
export * from './address';

// Order DTOs (Order, OrderItem, OrderStatus, CheckoutInput, CheckoutResult, …).
export * from './order';

// Review DTOs (Review, ReviewTargetType, CreateReviewInput, RatingAggregate, …).
export * from './review';

// Courier domain DTOs (Courier, CourierProfile, Vehicle, JobType, SizeClass, …).
export * from './courier';

// Courier company (fleet) admin-facing DTOs (Company, CompanyMember, CompanyRole, …).
export * from './company';

// Shipment DTOs (Shipment, ShipmentType, ShipmentStatus, ShipmentEndpoint, ParcelDetails, …).
// NOTE: GeoPoint/DimensionsCm/SizeClass are reused from './courier' (not re-declared here).
export * from './shipment';

// Quote DTOs (Quote, QuoteSource, PriceBreakdown, DisplayPriceBreakdown, QuoteList, …).
export * from './quote';

// Job DTOs (Job, JobStatus, FulfillmentType, JobStatusEvent, BookShipmentInput, …).
export * from './job';

// External-provider DTOs (Provider, ProviderSummary, ProviderQuote).
export * from './provider';

/**
 * Domain request schemas (Zod).
 *
 * The reusable validation FACTORIES live in `validate.ts`; this module holds the
 * concrete per-endpoint schemas (listing, store, member, variant, inventory,
 * seller-prefs) that those factories consume. Each schema parses into a shape
 * assignable to the matching `@moovo/shared-types` input DTO, so controllers
 * pass `req.body` straight to a service without re-shaping.
 *
 * `Money` input is `{ amount: int ≥ 0, currency: enum }`.
 */

import { z } from 'zod';

/** Supported currency codes (mirrors `CurrencyCode`). */
const currencySchema = z.enum(['USD', 'EUR', 'GBP']);

/** `Money` input: integer minor units, non-negative, with a supported currency. */
const moneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: currencySchema,
});

/** A single `{ name, value }` option assignment. */
const optionValueSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

/** A selectable option and its allowed values. */
const listingOptionSchema = z.object({
  name: z.string().trim().min(1),
  values: z.array(z.string().trim().min(1)).min(1),
});

// ---------------------------------------------------------------------------
// P2P listing
// ---------------------------------------------------------------------------

/** Body for `POST /seller/listings` (CreateP2PListingInput). */
export const createP2PListingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  price: moneySchema,
  condition: z.enum(['new', 'used']),
  category: z.string().trim().min(1),
  imageFileIds: z.array(z.string().trim().min(1)),
  tags: z.array(z.string().trim().min(1)).optional(),
  quantity: z.number().int().nonnegative().optional(),
});

/** Body for `PATCH /seller/listings/:id` and store `PATCH /products/:id` (UpdateListingInput). */
export const updateListingSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    price: moneySchema.optional(),
    condition: z.enum(['new', 'used']).optional(),
    category: z.string().trim().min(1).optional(),
    imageFileIds: z.array(z.string().trim().min(1)).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    quantity: z.number().int().nonnegative().optional(),
    status: z.enum(['draft', 'active', 'sold', 'archived']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Store product + variants
// ---------------------------------------------------------------------------

/** A variant supplied when creating a store product (CreateStoreProductVariantInput). */
const createStoreProductVariantSchema = z.object({
  optionValues: z.array(optionValueSchema),
  price: moneySchema,
  compareAtPrice: moneySchema.optional(),
  sku: z.string().trim().min(1).optional(),
  inventory: z.object({
    tracked: z.boolean().optional(),
    available: z.number().int().nonnegative(),
  }),
});

/** Body for store `POST /products` (CreateStoreProductInput). */
export const createStoreProductSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  category: z.string().trim().min(1),
  imageFileIds: z.array(z.string().trim().min(1)),
  tags: z.array(z.string().trim().min(1)).optional(),
  options: z.array(listingOptionSchema),
  variants: z.array(createStoreProductVariantSchema).min(1),
});

/** Body for store `POST /products/:id/variants` (add a variant). */
export const createVariantSchema = createStoreProductVariantSchema;

/** Body for store `PATCH /products/:id/variants/:variantId` (update a variant). */
export const updateVariantSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    sku: z.string().trim().min(1).optional(),
    price: moneySchema.optional(),
    compareAtPrice: moneySchema.nullable().optional(),
    optionValues: z.array(optionValueSchema).optional(),
    inventory: z
      .object({
        tracked: z.boolean().optional(),
        available: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for store `PATCH /products/:id/variants/:variantId/inventory`. */
export const setInventorySchema = z.object({
  available: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Store + members
// ---------------------------------------------------------------------------

/** Body for `POST /admin/stores` (CreateStoreInput). */
export const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5_000).optional(),
  brandColor: z.string().trim().min(1).optional(),
  logoFileId: z.string().trim().min(1).optional(),
  coverFileId: z.string().trim().min(1).optional(),
  defaultCurrency: currencySchema.optional(),
});

const storeRoleSchema = z.enum(['owner', 'admin', 'staff']);
const storePermissionSchema = z.enum([
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
]);

/** Body for `PATCH /admin/stores/:storeId` (UpdateStoreInput). */
export const updateStoreSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(5_000).optional(),
    brandColor: z.string().trim().min(1).optional(),
    logoFileId: z.string().trim().min(1).optional(),
    coverFileId: z.string().trim().min(1).optional(),
    defaultCurrency: currencySchema.optional(),
    textTone: z.enum(['light', 'dark']).optional(),
    status: z.enum(['active', 'suspended', 'closed']).optional(),
    policies: z
      .object({
        returnWindowDays: z.number().int().nonnegative().optional(),
        shippingNote: z.string().max(2_000).optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST /admin/stores/:storeId/members` (InviteMemberInput). */
export const inviteMemberSchema = z.object({
  oxyUserId: z.string().trim().min(1),
  role: storeRoleSchema,
  permissions: z.array(storePermissionSchema).optional(),
});

/** Body for `PATCH /admin/stores/:storeId/members/:oxyUserId` (UpdateMemberInput). */
export const updateMemberSchema = z
  .object({
    role: storeRoleSchema.optional(),
    permissions: z.array(storePermissionSchema).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Seller profile prefs
// ---------------------------------------------------------------------------

/** Body for `PATCH /seller/me` (shipping/return preferences). */
export const sellerPrefsSchema = z
  .object({
    shippingPrefs: z
      .object({
        note: z.string().max(2_000).optional(),
        handlingDays: z.number().int().nonnegative().optional(),
      })
      .optional(),
    returnPrefs: z
      .object({
        accepts: z.boolean().optional(),
        windowDays: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/** Body for `POST /cart/items` (AddCartItemInput). */
export const addCartItemSchema = z.object({
  listingId: z.string().trim().min(1),
  variantId: z.string().trim().min(1),
  quantity: z.number().int().positive(),
});

/** Body for `PATCH /cart/items/:variantId` (UpdateCartItemInput). 0 removes the line. */
export const updateCartItemSchema = z.object({
  quantity: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** Body for `POST /addresses` (CreateAddressInput). */
export const createAddressSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  recipientName: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(150),
  region: z.string().trim().min(1).max(150).optional(),
  postalCode: z.string().trim().min(1).max(40),
  country: z.string().trim().min(2).max(2),
  phone: z.string().trim().min(1).max(40).optional(),
});

/** Body for `PATCH /addresses/:id` (UpdateAddressInput). */
export const updateAddressSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    recipientName: z.string().trim().min(1).max(200).optional(),
    line1: z.string().trim().min(1).max(300).optional(),
    line2: z.string().trim().min(1).max(300).optional(),
    city: z.string().trim().min(1).max(150).optional(),
    region: z.string().trim().min(1).max(150).optional(),
    postalCode: z.string().trim().min(1).max(40).optional(),
    country: z.string().trim().min(2).max(2).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Orders / checkout
// ---------------------------------------------------------------------------

/** A shipping method selectable at checkout. */
const shippingMethodSchema = z.enum(['standard', 'express', 'pickup']);

/** Every order status (used by status-patch + order list filters). */
const orderStatusSchema = z.enum([
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
]);

/** Body for `POST /checkout` (CheckoutInput). */
export const checkoutSchema = z.object({
  addressId: z.string().trim().min(1),
  shippingSelections: z.record(z.string(), shippingMethodSchema).optional(),
});

/**
 * Body for store `PATCH /admin/stores/:storeId/orders/:id/status`. Restricted to
 * the fulfilment subset — a store may advance an order along
 * processing/shipped/delivered or cancel it, but `paid`/`refunded` are payment
 * outcomes and MUST NOT be settable via this route.
 */
export const orderStatusPatchSchema = z.object({
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  trackingNumber: z.string().trim().min(1).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Body for seller `PATCH /seller/orders/:id/fulfill`. */
export const fulfillOrderSchema = z.object({
  status: z.enum(['processing', 'shipped', 'delivered']),
  trackingNumber: z.string().trim().min(1).optional(),
});

/** Query for order list endpoints (`page`/`limit` + optional `status` filter). */
export const orderListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: orderStatusSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Pagination query
// ---------------------------------------------------------------------------

/** Reusable offset-pagination query (`page`/`limit`). */
export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** Body for `POST /reviews` (CreateReviewInput). The target id must match the type. */
export const createReviewSchema = z
  .object({
    targetType: z.enum(['listing', 'store', 'seller']),
    listingId: z.string().trim().min(1).optional(),
    storeId: z.string().trim().min(1).optional(),
    sellerOxyUserId: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().max(5000).optional(),
  })
  .refine(
    (o) =>
      (o.targetType === 'listing' && !!o.listingId) ||
      (o.targetType === 'store' && !!o.storeId) ||
      (o.targetType === 'seller' && !!o.sellerOxyUserId),
    { message: 'targetType requires the matching target id' },
  );

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Body for `POST /feedback` (CreateFeedbackInput). Mirrors the `IFeedback` model. */
export const feedbackSchema = z.object({
  type: z.enum(['bug', 'feature', 'improvement', 'other']),
  rating: z.number().int().min(1).max(5).optional(),
  message: z.string().trim().min(1).max(10_000),
  email: z.string().trim().email().max(320).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Query for `GET /notifications` (`page`/`limit` + optional `status`/`type` filter). */
export const notificationListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z.enum(['pending', 'sent', 'read', 'dismissed']).optional(),
    type: z.string().trim().min(1).optional(),
  })
  .passthrough();

/** Body for `POST /notifications/push-token` (register/update an Expo push token). */
export const pushTokenSchema = z.object({
  token: z.string().trim().min(1),
  deviceId: z.string().trim().min(1).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

/** Body for `DELETE /notifications/push-token` (deactivate an Expo push token). */
export const pushTokenDeleteSchema = z.object({
  token: z.string().trim().min(1),
});

/** Body for `POST /notifications/web-push-subscription` (save a browser subscription). */
export const webPushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(1),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  }),
});

/** Body for `DELETE /notifications/web-push-subscription` (deactivate a subscription). */
export const webPushSubscriptionDeleteSchema = z.object({
  endpoint: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Courier / transport — vehicles, location ping, active vehicle
// ---------------------------------------------------------------------------

const vehicleTypeSchema = z.enum(['bike', 'scooter', 'car', 'van', 'truck']);

/** Cargo bounding dimensions (centimetres). */
const dimsCmSchema = z.object({
  l: z.number().positive(),
  w: z.number().positive(),
  h: z.number().positive(),
});

/** Optional capacity overrides; weight defaults from the capability table. */
const vehicleCapacityInputSchema = z.object({
  maxWeightKg: z.number().positive().optional(),
  maxVolumeL: z.number().positive().optional(),
  maxDimsCm: dimsCmSchema.optional(),
});

/** Body for `POST /courier/vehicles` and company `POST /vehicles` (CreateVehicleInput). */
export const createVehicleSchema = z.object({
  type: vehicleTypeSchema,
  label: z.string().trim().min(1).max(120).optional(),
  plate: z.string().trim().min(1).max(40).optional(),
  capacity: vehicleCapacityInputSchema.optional(),
});

/** Body for vehicle `PATCH` endpoints (at least one field). */
export const updateVehicleSchema = z
  .object({
    type: vehicleTypeSchema.optional(),
    label: z.string().trim().min(1).max(120).optional(),
    plate: z.string().trim().min(1).max(40).optional(),
    capacity: vehicleCapacityInputSchema.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `PATCH /courier/me` (editable courier preferences). */
export const courierPrefsSchema = z
  .object({
    payout: z
      .object({
        accountRef: z.string().trim().min(1).max(200).optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST /courier/location` (a GeoJSON-friendly lng/lat ping). */
export const locationPingSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/** Body for `POST /courier/active-vehicle`. */
export const setActiveVehicleSchema = z.object({
  vehicleId: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Courier company (fleet) + members
// ---------------------------------------------------------------------------

/** A GeoJSON point `[lng, lat]`. */
const geoPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});

/** A company service area (circle around a center point). */
const serviceAreaSchema = z.object({
  center: geoPointSchema,
  radiusM: z.number().positive(),
});

/** Body for `POST /admin/companies` (CreateCompanyInput). */
export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5_000).optional(),
  brandColor: z.string().trim().min(1).optional(),
  logoFileId: z.string().trim().min(1).optional(),
  coverFileId: z.string().trim().min(1).optional(),
  defaultCurrency: currencySchema.optional(),
  serviceAreas: z.array(serviceAreaSchema).optional(),
});

const companyRoleSchema = z.enum(['owner', 'dispatcher', 'driver']);
const companyPermissionSchema = z.enum([
  'company:manage',
  'members:manage',
  'fleet:write',
  'jobs:read',
  'jobs:dispatch',
  'stats:read',
]);

/** Body for `PATCH /admin/companies/:companyId` (UpdateCompanyInput). */
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(5_000).optional(),
    brandColor: z.string().trim().min(1).optional(),
    logoFileId: z.string().trim().min(1).optional(),
    coverFileId: z.string().trim().min(1).optional(),
    defaultCurrency: currencySchema.optional(),
    serviceAreas: z.array(serviceAreaSchema).optional(),
    textTone: z.enum(['light', 'dark']).optional(),
    status: z.enum(['active', 'suspended', 'closed']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST /admin/companies/:companyId/members` (InviteCompanyMemberInput). */
export const inviteCompanyMemberSchema = z.object({
  oxyUserId: z.string().trim().min(1),
  role: companyRoleSchema,
  permissions: z.array(companyPermissionSchema).optional(),
});

/** Body for `PATCH /admin/companies/:companyId/members/:oxyUserId` (UpdateCompanyMemberInput). */
export const updateCompanyMemberSchema = z
  .object({
    role: companyRoleSchema.optional(),
    permissions: z.array(companyPermissionSchema).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Shipments / quotes / jobs (transport domain)
// ---------------------------------------------------------------------------

const shipmentTypeSchema = z.enum(['package', 'food', 'move']);
const sizeClassSchema = z.enum(['small', 'medium', 'large']);

/** A shipment endpoint's postal address. */
const shipmentAddressSchema = z.object({
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(150),
  region: z.string().trim().min(1).max(150).optional(),
  postalCode: z.string().trim().min(1).max(40),
  country: z.string().trim().min(2).max(2),
});

/** A shipment endpoint (location + address + contact). */
const shipmentEndpointSchema = z.object({
  location: geoPointSchema,
  address: shipmentAddressSchema,
  contactName: z.string().trim().min(1).max(200),
  contactPhone: z.string().trim().min(1).max(40),
  notes: z.string().trim().max(2000).optional(),
});

/** Parcel/cargo details of a shipment. */
const parcelDetailsSchema = z.object({
  weightKg: z.number().nonnegative(),
  dimsCm: dimsCmSchema.optional(),
  sizeClass: sizeClassSchema,
  pieces: z.number().int().positive(),
  fragile: z.boolean().optional(),
});

/** When the shipment should be fulfilled. */
const schedulingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('scheduled'), scheduledFor: z.string().datetime() }),
]);

/** A shipment reference photo (Oxy media file id). */
const shipmentPhotoSchema = z.object({
  fileId: z.string().trim().min(1),
  alt: z.string().trim().min(1).max(300).optional(),
  position: z.number().int().nonnegative(),
});

/** Body for `POST /shipments` (CreateShipmentInput). */
export const createShipmentSchema = z.object({
  type: shipmentTypeSchema,
  pickup: shipmentEndpointSchema,
  dropoff: shipmentEndpointSchema,
  parcel: parcelDetailsSchema,
  itemDescription: z.string().trim().max(2000),
  photos: z.array(shipmentPhotoSchema).optional(),
  scheduling: schedulingSchema.optional(),
});

/** Query for shipment list endpoints (`page`/`limit` + optional `status`/`type`). */
export const shipmentListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z
      .enum(['draft', 'quoting', 'quoted', 'booked', 'cancelled', 'expired'])
      .optional(),
    type: shipmentTypeSchema.optional(),
  })
  .passthrough();

/** Body for `POST /shipments/:id/book` (BookShipmentInput). */
export const bookShipmentSchema = z.object({
  quoteId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/** Query for job list endpoints (`page`/`limit` + optional `status`/`role`). */
export const jobListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z
      .enum(['requested', 'accepted', 'picked_up', 'in_transit', 'delivered', 'cancelled'])
      .optional(),
    role: z.enum(['sender', 'courier']).optional(),
  })
  .passthrough();

/** Body for the job lifecycle transitions that accept an optional location. */
export const jobLocationSchema = z
  .object({
    lng: z.number().min(-180).max(180).optional(),
    lat: z.number().min(-90).max(90).optional(),
  })
  .refine((o) => (o.lng === undefined) === (o.lat === undefined), {
    message: 'lng and lat must be provided together',
  });

/** Body for `POST /jobs/:id/location` (a required lng/lat ping). */
export const jobLocationPingSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/** Body for `POST /jobs/:id/deliver` (DeliverInput + optional location). */
export const deliverJobSchema = z.object({
  photoFileId: z.string().trim().min(1).optional(),
  signatureFileId: z.string().trim().min(1).optional(),
  note: z.string().trim().max(2000).optional(),
  recipientName: z.string().trim().min(1).max(200).optional(),
  lng: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-90).max(90).optional(),
});

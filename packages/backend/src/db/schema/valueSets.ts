/**
 * Every closed value set in the schema, as `as const` tuples.
 *
 * Each one types a column AND generates that column's CHECK constraint, from
 * the same tuple, so the TypeScript union and the database constraint cannot
 * drift apart. Where the source already declares the tuple in
 * `@moovo/shared-types`, it is RE-EXPORTED rather than restated — a second
 * copy is exactly the drift this file exists to prevent.
 */

export {
  MODERATION_ENFORCEMENT_ACTIONS,
  MODERATION_LOCAL_STATUSES,
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from '@moovo/shared-types';

/**
 * The MARKETPLACE currency set — `Money.currency`.
 *
 * Deliberately NOT unified with {@link SUPPORTED_CURRENCIES} below. They are
 * different sets serving different halves of the product: a listing cannot be
 * priced in FAIR, and a transport quote is only ever FAIR. Merging them would
 * make both columns accept values their own domain has no meaning for.
 */
export const CURRENCY_CODES = ['USD', 'EUR', 'GBP'] as const;

/**
 * The TRANSPORT currency set — `FairMoney.originalCurrency`, the optional
 * audit trail of what a user originally entered.
 */
export const SUPPORTED_CURRENCIES = ['FAIR', 'EUR', 'USD'] as const;

/** What a transport price is actually denominated in. One value, on purpose. */
export const FAIR_CURRENCIES = ['FAIR'] as const;

export const SHIPMENT_TYPES = ['package', 'food', 'move'] as const;
export const SHIPMENT_STATUSES = [
  'draft',
  'quoting',
  'quoted',
  'booked',
  'cancelled',
  'expired',
] as const;
export const SCHEDULING_KINDS = ['now', 'scheduled'] as const;
export const SIZE_CLASSES = ['small', 'medium', 'large'] as const;

export const JOB_STATUSES = [
  'requested',
  'offered',
  'accepted',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
] as const;
export const FULFILLMENT_TYPES = ['moovo_courier', 'external_provider'] as const;
export const JOB_OFFER_STATUSES = [
  'offered',
  'accepted',
  'declined',
  'expired',
  'superseded',
] as const;

export const QUOTE_SOURCES = ['moovo_courier', 'external_provider'] as const;
export const QUOTE_STATUSES = ['active', 'selected', 'expired'] as const;

export const PAYMENT_STATUSES = ['unpaid', 'authorized', 'paid', 'refunded', 'failed'] as const;
export const PAYMENT_PROVIDERS = ['oxy_pay'] as const;

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export const ORDER_SELLER_TYPES = ['user', 'store'] as const;
export const SHIPPING_METHODS = ['standard', 'express', 'pickup'] as const;

export const STORE_ROLES = ['owner', 'admin', 'staff'] as const;
export const STORE_PERMISSIONS = [
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
] as const;
export const STORE_STATUSES = ['active', 'suspended', 'closed'] as const;

export const COMPANY_ROLES = ['owner', 'dispatcher', 'driver'] as const;
export const COMPANY_PERMISSIONS = [
  'company:manage',
  'members:manage',
  'fleet:write',
  'jobs:read',
  'jobs:dispatch',
  'stats:read',
] as const;
export const COMPANY_STATUSES = ['active', 'suspended', 'closed'] as const;

export const TEXT_TONES = ['light', 'dark'] as const;

export const COURIER_STATUSES = ['pending', 'active', 'suspended'] as const;
export const ONLINE_STATUSES = ['online', 'offline', 'on_job'] as const;

export const VEHICLE_OWNER_TYPES = ['courier', 'company'] as const;
export const VEHICLE_TYPES = ['bike', 'scooter', 'car', 'van', 'truck'] as const;
export const VEHICLE_STATUSES = ['active', 'inactive'] as const;

/** `JobType` — what a vehicle or courier is eligible to carry. */
export const JOB_TYPES = ['package', 'food', 'move'] as const;

export const REVIEW_TARGET_TYPES = ['listing', 'store', 'seller'] as const;
export const REVIEW_STATUSES = ['published', 'hidden'] as const;

/**
 * Notification types.
 *
 * NINE of these have no producer anywhere in this codebase — `trigger_result`,
 * `proactive_insight`, `daily_briefing`, `price_alert`, `integration_event`,
 * `reminder`, `agent_task_complete`, `chat_response_ready` and `oxy_service`
 * are AI-assistant scaffolding inherited from another Oxy app, alongside the
 * `triggerId` column that points at a `Trigger` collection which does not
 * exist here either.
 *
 * They are kept ANYWAY, and the asymmetry is the reason: a dead value in this
 * tuple costs nothing, while a CHECK that refuses a type something does still
 * send is a failed insert in production. Removing them is a `post` migration
 * to make deliberately, after confirming against a live database — not a
 * guess to bake into the foundation.
 */
export const NOTIFICATION_TYPES = [
  'trigger_result',
  'proactive_insight',
  'daily_briefing',
  'price_alert',
  'integration_event',
  'reminder',
  'agent_task_complete',
  'chat_response_ready',
  'oxy_service',
  'order_placed',
  'order_paid',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'listing_sold',
  'review_received',
  'store_member_invited',
  'low_inventory',
  'company_member_invited',
  'job_offered',
  'job_accepted',
  'job_picked_up',
  'job_in_transit',
  'job_delivered',
  'job_cancelled',
  'dispatch_no_courier',
] as const;
export const NOTIFICATION_CHANNELS = [
  'push',
  'telegram',
  'discord',
  'whatsapp',
  'slack',
  'in_app',
] as const;
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'read', 'dismissed'] as const;
export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;
export const FEEDBACK_STATUSES = ['pending', 'reviewed', 'resolved'] as const;
export const PUSH_PLATFORMS = ['ios', 'android', 'web'] as const;

export const MODERATION_OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;
export const MODERATION_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
] as const;
export const MODERATION_EVENT_STATES = ['claimed', 'queued', 'ignored'] as const;
export const MODERATION_ENFORCEMENT_TARGET_TYPES = ['courier', 'customer', 'delivery'] as const;

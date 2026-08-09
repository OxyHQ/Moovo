-- oxy:deploy-phase=pre
--
-- Every statement here CREATES something: 34 tables, 2 sequences and their
-- indexes and constraints. Nothing is dropped, renamed or narrowed, so the
-- previous image — which reads none of these tables — tolerates it completely.

CREATE SEQUENCE "public"."job_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" text,
	"ancestor_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_url" text,
	"image_file_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"committed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"oxy_user_id" text,
	"store_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"condition" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"category_id" text,
	"category_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_min_amount" bigint,
	"price_min_currency" text,
	"price_max_amount" bigint,
	"price_max_currency" text,
	"has_inventory" boolean DEFAULT false NOT NULL,
	"variant_count" integer DEFAULT 0 NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')) || array_to_tsvector(coalesce(tags, '{}'))) STORED,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listings_owner_type_check" CHECK ("listings"."owner_type" in ('user', 'store')),
	CONSTRAINT "listings_condition_check" CHECK ("listings"."condition" in ('new', 'used')),
	CONSTRAINT "listings_status_check" CHECK ("listings"."status" in ('draft', 'active', 'sold', 'archived')),
	CONSTRAINT "listings_price_min_currency_check" CHECK ("listings"."price_min_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "listings_price_max_currency_check" CHECK ("listings"."price_max_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "listings_owner_shape_check" CHECK (("listings"."owner_type" = 'user' and "listings"."oxy_user_id" is not null and "listings"."store_id" is null)
       or ("listings"."owner_type" = 'store' and "listings"."store_id" is not null and "listings"."oxy_user_id" is null)),
	CONSTRAINT "listings_location_shape_check" CHECK (("listings"."latitude" is null) = ("listings"."longitude" is null)),
	CONSTRAINT "listings_price_min_shape_check" CHECK (("listings"."price_min_amount" is null) = ("listings"."price_min_currency" is null)),
	CONSTRAINT "listings_price_max_shape_check" CHECK (("listings"."price_max_amount" is null) = ("listings"."price_max_currency" is null))
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"title" text DEFAULT 'Default Title' NOT NULL,
	"option_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sku" text,
	"price_amount" bigint NOT NULL,
	"price_currency" text NOT NULL,
	"compare_at_amount" bigint,
	"compare_at_currency" text,
	"inventory_tracked" boolean DEFAULT true NOT NULL,
	"inventory_available" integer DEFAULT 0 NOT NULL,
	"inventory_committed" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_variants_price_currency_check" CHECK ("product_variants"."price_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "product_variants_compare_at_currency_check" CHECK ("product_variants"."compare_at_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "product_variants_compare_at_shape_check" CHECK (("product_variants"."compare_at_amount" is null) = ("product_variants"."compare_at_currency" is null))
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"label" text,
	"recipient_name" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cart_items_quantity_check" CHECK ("cart_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "carts_currency_check" CHECK ("carts"."currency" in ('USD', 'EUR', 'GBP'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"title" text NOT NULL,
	"variant_title" text NOT NULL,
	"image_url" text,
	"option_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_amount" bigint NOT NULL,
	"line_total_currency" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_items_unit_price_currency_check" CHECK ("order_items"."unit_price_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "order_items_line_total_currency_check" CHECK ("order_items"."line_total_currency" in ('USD', 'EUR', 'GBP'))
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"by_oxy_user_id" text,
	"note" text,
	CONSTRAINT "order_status_events_status_check" CHECK ("order_status_events"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"buyer_oxy_user_id" text NOT NULL,
	"seller_type" text NOT NULL,
	"seller_oxy_user_id" text,
	"store_id" text,
	"ship_to_label" text,
	"ship_to_recipient_name" text NOT NULL,
	"ship_to_line1" text NOT NULL,
	"ship_to_line2" text,
	"ship_to_city" text NOT NULL,
	"ship_to_region" text,
	"ship_to_postal_code" text NOT NULL,
	"ship_to_country" text NOT NULL,
	"ship_to_phone" text,
	"shipping_method" text NOT NULL,
	"shipping_label" text NOT NULL,
	"shipping_cost_amount" bigint NOT NULL,
	"shipping_cost_currency" text NOT NULL,
	"tracking_number" text,
	"subtotal_amount" bigint NOT NULL,
	"subtotal_currency" text NOT NULL,
	"grand_total_amount" bigint NOT NULL,
	"grand_total_currency" text NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_provider" text DEFAULT 'oxy_pay' NOT NULL,
	"payment_reference" text,
	"paid_at" timestamp with time zone,
	"checkout_group_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "orders_seller_type_check" CHECK ("orders"."seller_type" in ('user', 'store')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
	CONSTRAINT "orders_shipping_method_check" CHECK ("orders"."shipping_method" in ('standard', 'express', 'pickup')),
	CONSTRAINT "orders_shipping_cost_currency_check" CHECK ("orders"."shipping_cost_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "orders_subtotal_currency_check" CHECK ("orders"."subtotal_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "orders_grand_total_currency_check" CHECK ("orders"."grand_total_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "orders_payment_status_check" CHECK ("orders"."payment_status" in ('unpaid', 'authorized', 'paid', 'refunded', 'failed')),
	CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('oxy_pay')),
	CONSTRAINT "orders_seller_shape_check" CHECK (("orders"."seller_type" = 'user' and "orders"."seller_oxy_user_id" is not null and "orders"."store_id" is null)
       or ("orders"."seller_type" = 'store' and "orders"."store_id" is not null and "orders"."seller_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" integer,
	"message" text NOT NULL,
	"email" text,
	"metadata_platform" text,
	"metadata_app_version" text,
	"metadata_device_info" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feedback_type_check" CHECK ("feedback"."type" in ('bug', 'feature', 'improvement', 'other')),
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" in ('pending', 'reviewed', 'resolved')),
	CONSTRAINT "feedback_rating_check" CHECK ("feedback"."rating" is null or "feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"token" text NOT NULL,
	"device_id" text,
	"platform" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"listing_id" text,
	"store_id" text,
	"seller_oxy_user_id" text,
	"order_id" text,
	"rating" integer NOT NULL,
	"title" text,
	"body" text,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reviews_target_type_check" CHECK ("reviews"."target_type" in ('listing', 'store', 'seller')),
	CONSTRAINT "reviews_status_check" CHECK ("reviews"."status" in ('published', 'hidden')),
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"key_p_256dh" text NOT NULL,
	"key_auth" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"joined_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "company_members_role_check" CHECK ("company_members"."role" in ('owner', 'dispatcher', 'driver')),
	CONSTRAINT "company_members_permissions_check" CHECK ("company_members"."permissions" <@ array['company:manage', 'members:manage', 'fleet:write', 'jobs:read', 'jobs:dispatch', 'stats:read']::text[])
);
--> statement-breakpoint
CREATE TABLE "company_service_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"center" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"radius_m" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "company_service_areas_center_shape_check" CHECK (("company_service_areas"."latitude" is null) = ("company_service_areas"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "courier_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"logo_file_id" text,
	"cover_file_id" text,
	"brand_color" text NOT NULL,
	"text_tone" text DEFAULT 'light' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"payout_provider" text DEFAULT 'oxy_pay' NOT NULL,
	"payout_account_ref" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "courier_companies_text_tone_check" CHECK ("courier_companies"."text_tone" in ('light', 'dark')),
	CONSTRAINT "courier_companies_status_check" CHECK ("courier_companies"."status" in ('active', 'suspended', 'closed')),
	CONSTRAINT "courier_companies_default_currency_check" CHECK ("courier_companies"."default_currency" in ('USD', 'EUR', 'GBP')),
	CONSTRAINT "courier_companies_payout_provider_check" CHECK ("courier_companies"."payout_provider" in ('oxy_pay'))
);
--> statement-breakpoint
CREATE TABLE "courier_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"online_status" text DEFAULT 'offline' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"last_ping_at" timestamp with time zone,
	"active_vehicle_id" text,
	"eligible_job_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_weight_kg" double precision DEFAULT 0 NOT NULL,
	"max_size_class" text DEFAULT 'small' NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"cancelled_jobs" integer DEFAULT 0 NOT NULL,
	"acceptance_rate" double precision,
	"payout_provider" text DEFAULT 'oxy_pay' NOT NULL,
	"payout_account_ref" text,
	"company_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "courier_profiles_status_check" CHECK ("courier_profiles"."status" in ('pending', 'active', 'suspended')),
	CONSTRAINT "courier_profiles_online_status_check" CHECK ("courier_profiles"."online_status" in ('online', 'offline', 'on_job')),
	CONSTRAINT "courier_profiles_eligible_job_types_check" CHECK ("courier_profiles"."eligible_job_types" <@ array['package', 'food', 'move']::text[]),
	CONSTRAINT "courier_profiles_max_size_class_check" CHECK ("courier_profiles"."max_size_class" in ('small', 'medium', 'large')),
	CONSTRAINT "courier_profiles_payout_provider_check" CHECK ("courier_profiles"."payout_provider" in ('oxy_pay')),
	CONSTRAINT "courier_profiles_location_shape_check" CHECK (("courier_profiles"."latitude" is null) = ("courier_profiles"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"courier_oxy_user_id" text,
	"company_id" text,
	"type" text NOT NULL,
	"label" text,
	"plate" text,
	"max_weight_kg" double precision DEFAULT 0 NOT NULL,
	"max_volume_l" double precision,
	"max_dims_l" double precision,
	"max_dims_w" double precision,
	"max_dims_h" double precision,
	"eligible_job_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "vehicles_owner_type_check" CHECK ("vehicles"."owner_type" in ('courier', 'company')),
	CONSTRAINT "vehicles_type_check" CHECK ("vehicles"."type" in ('bike', 'scooter', 'car', 'van', 'truck')),
	CONSTRAINT "vehicles_status_check" CHECK ("vehicles"."status" in ('active', 'inactive')),
	CONSTRAINT "vehicles_eligible_job_types_check" CHECK ("vehicles"."eligible_job_types" <@ array['package', 'food', 'move']::text[]),
	CONSTRAINT "vehicles_owner_shape_check" CHECK (("vehicles"."owner_type" = 'courier' and "vehicles"."courier_oxy_user_id" is not null and "vehicles"."company_id" is null)
       or ("vehicles"."owner_type" = 'company' and "vehicles"."company_id" is not null and "vehicles"."courier_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "moderation_enforcements" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"case_id" text,
	"report_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('none', 'suspend_courier', 'reinstate_courier', 'manual_review')),
	CONSTRAINT "moderation_enforcements_target_type_check" CHECK ("moderation_enforcements"."target_type" in ('courier', 'customer', 'delivery')),
	CONSTRAINT "moderation_enforcements_reason_length_check" CHECK (char_length("moderation_enforcements"."reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text,
	"case_id" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_events_state_check" CHECK ("moderation_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_outboxes_kind_check" CHECK ("moderation_outboxes"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outboxes_status_check" CHECK ("moderation_outboxes"."status" in ('pending', 'processing', 'processed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter" text NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"context_job_id" text,
	"categories" text[] NOT NULL,
	"details" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" text,
	"last_delivery_error" text,
	"content_snapshot_hash" text,
	"crowd_source_report_id" text,
	"crowd_source_case_id" text,
	"crowd_source_merged" boolean,
	"decision_revision" integer,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('courier', 'customer', 'delivery', 'listing', 'store', 'review')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('pending', 'reviewed', 'resolved', 'dismissed')),
	CONSTRAINT "reports_local_status_check" CHECK ("reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "reports_categories_check" CHECK ("reports"."categories" <@ array['prohibited_item', 'unsafe_conduct', 'harassment', 'discrimination', 'threat', 'theft_or_damage', 'impersonation', 'privacy', 'service_failure', 'other']::text[]),
	CONSTRAINT "reports_details_length_check" CHECK ("reports"."details" is null or char_length("reports"."details") <= 2000),
	CONSTRAINT "reports_local_status_reason_length_check" CHECK ("reports"."local_status_reason" is null or char_length("reports"."local_status_reason") <= 300),
	CONSTRAINT "reports_last_delivery_error_length_check" CHECK ("reports"."last_delivery_error" is null or char_length("reports"."last_delivery_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"trigger_id" text,
	"conversation_id" text,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"dismissed_since" timestamp with time zone GENERATED ALWAYS AS (case when status = 'dismissed' then created_at end) STORED,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'listing_sold', 'review_received', 'store_member_invited', 'low_inventory', 'company_member_invited', 'job_offered', 'job_accepted', 'job_picked_up', 'job_in_transit', 'job_delivered', 'job_cancelled', 'dispatch_no_courier')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('pending', 'sent', 'read', 'dismissed')),
	CONSTRAINT "notifications_priority_check" CHECK ("notifications"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "notifications_channels_check" CHECK ("notifications"."channels" <@ array['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app']::text[])
);
--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"shipping_note" text,
	"shipping_handling_days" integer,
	"return_accepts" boolean,
	"return_window_days" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_members" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "store_members_role_check" CHECK ("store_members"."role" in ('owner', 'admin', 'staff')),
	CONSTRAINT "store_members_permissions_check" CHECK ("store_members"."permissions" <@ array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'orders:read', 'orders:fulfill', 'stats:read']::text[])
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"logo_file_id" text,
	"cover_file_id" text,
	"brand_color" text NOT NULL,
	"text_tone" text DEFAULT 'light' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_return_window_days" integer DEFAULT 30 NOT NULL,
	"policy_shipping_note" text,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"product_count" integer DEFAULT 0 NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "stores_text_tone_check" CHECK ("stores"."text_tone" in ('light', 'dark')),
	CONSTRAINT "stores_status_check" CHECK ("stores"."status" in ('active', 'suspended', 'closed')),
	CONSTRAINT "stores_default_currency_check" CHECK ("stores"."default_currency" in ('USD', 'EUR', 'GBP'))
);
--> statement-breakpoint
CREATE TABLE "job_location_pings" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"shipment_id" text NOT NULL,
	"courier_oxy_user_id" text NOT NULL,
	"company_id" text,
	"status" text DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rank" integer NOT NULL,
	"distance_m" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"reapable_since" timestamp with time zone GENERATED ALWAYS AS (case when status <> 'offered' then expires_at end) STORED,
	CONSTRAINT "job_offers_status_check" CHECK ("job_offers"."status" in ('offered', 'accepted', 'declined', 'expired', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "job_status_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"by_oxy_user_id" text,
	"note" text,
	"latitude" double precision,
	"longitude" double precision,
	"location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "job_status_events_status_check" CHECK ("job_status_events"."status" in ('requested', 'offered', 'accepted', 'picked_up', 'in_transit', 'delivered', 'cancelled')),
	CONSTRAINT "job_status_events_location_shape_check" CHECK (("job_status_events"."latitude" is null) = ("job_status_events"."longitude" is null))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_number" text NOT NULL,
	"shipment_id" text NOT NULL,
	"sender_oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"fulfillment_type" text NOT NULL,
	"courier_oxy_user_id" text,
	"company_id" text,
	"provider_ref" text,
	"pickup_latitude" double precision NOT NULL,
	"pickup_longitude" double precision NOT NULL,
	"pickup_location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(pickup_longitude, pickup_latitude), 4326)::geography) STORED,
	"pickup_line1" text NOT NULL,
	"pickup_line2" text,
	"pickup_city" text NOT NULL,
	"pickup_region" text,
	"pickup_postal_code" text NOT NULL,
	"pickup_country" text NOT NULL,
	"pickup_contact_name" text NOT NULL,
	"pickup_contact_phone" text NOT NULL,
	"pickup_notes" text,
	"dropoff_latitude" double precision NOT NULL,
	"dropoff_longitude" double precision NOT NULL,
	"dropoff_location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(dropoff_longitude, dropoff_latitude), 4326)::geography) STORED,
	"dropoff_line1" text NOT NULL,
	"dropoff_line2" text,
	"dropoff_city" text NOT NULL,
	"dropoff_region" text,
	"dropoff_postal_code" text NOT NULL,
	"dropoff_country" text NOT NULL,
	"dropoff_contact_name" text NOT NULL,
	"dropoff_contact_phone" text NOT NULL,
	"dropoff_notes" text,
	"parcel_weight_kg" double precision NOT NULL,
	"parcel_dims_l" double precision,
	"parcel_dims_w" double precision,
	"parcel_dims_h" double precision,
	"parcel_size_class" text NOT NULL,
	"parcel_pieces" integer DEFAULT 1 NOT NULL,
	"parcel_fragile" boolean DEFAULT false NOT NULL,
	"quote_snapshot" jsonb NOT NULL,
	"totals" jsonb NOT NULL,
	"total_fair_minor" bigint GENERATED ALWAYS AS (((totals -> 'total' ->> 'fairMinor')::bigint)) STORED,
	"status" text DEFAULT 'requested' NOT NULL,
	"pod_photo_file_id" text,
	"pod_signature_file_id" text,
	"pod_note" text,
	"pod_recipient_name" text,
	"pod_at" timestamp with time zone,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_provider" text DEFAULT 'oxy_pay' NOT NULL,
	"payment_reference" text,
	"paid_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"pickup_code_hash" text,
	"dropoff_code_hash" text,
	"pickup_code" text,
	"dropoff_code" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "jobs_type_check" CHECK ("jobs"."type" in ('package', 'food', 'move')),
	CONSTRAINT "jobs_fulfillment_type_check" CHECK ("jobs"."fulfillment_type" in ('moovo_courier', 'external_provider')),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('requested', 'offered', 'accepted', 'picked_up', 'in_transit', 'delivered', 'cancelled')),
	CONSTRAINT "jobs_size_class_check" CHECK ("jobs"."parcel_size_class" in ('small', 'medium', 'large')),
	CONSTRAINT "jobs_payment_status_check" CHECK ("jobs"."payment_status" in ('unpaid', 'authorized', 'paid', 'refunded', 'failed')),
	CONSTRAINT "jobs_payment_provider_check" CHECK ("jobs"."payment_provider" in ('oxy_pay')),
	CONSTRAINT "jobs_fulfillment_shape_check" CHECK (("jobs"."fulfillment_type" = 'moovo_courier' and "jobs"."provider_ref" is null)
       or ("jobs"."fulfillment_type" = 'external_provider'
           and "jobs"."provider_ref" is not null
           and "jobs"."courier_oxy_user_id" is null
           and "jobs"."company_id" is null))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"logo_file_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"supported_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"supported_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "providers_supported_types_check" CHECK ("providers"."supported_types" <@ array['package', 'food', 'move']::text[])
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"source" text NOT NULL,
	"provider_id" text,
	"provider_quote_ref" text,
	"base_fair_minor" bigint NOT NULL,
	"distance_fair_minor" bigint NOT NULL,
	"size_fair_minor" bigint NOT NULL,
	"surge_fair_minor" bigint,
	"fees_fair_minor" bigint,
	"total_fair_minor" bigint NOT NULL,
	"original_currency" text,
	"original_amount" bigint,
	"currency" text DEFAULT 'FAIR' NOT NULL,
	"eta_pickup_min" integer,
	"eta_delivery_min" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "quotes_source_check" CHECK ("quotes"."source" in ('moovo_courier', 'external_provider')),
	CONSTRAINT "quotes_status_check" CHECK ("quotes"."status" in ('active', 'selected', 'expired')),
	CONSTRAINT "quotes_currency_check" CHECK ("quotes"."currency" in ('FAIR')),
	CONSTRAINT "quotes_original_currency_check" CHECK ("quotes"."original_currency" in ('FAIR', 'EUR', 'USD'))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"pickup_latitude" double precision NOT NULL,
	"pickup_longitude" double precision NOT NULL,
	"pickup_location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(pickup_longitude, pickup_latitude), 4326)::geography) STORED,
	"pickup_line1" text NOT NULL,
	"pickup_line2" text,
	"pickup_city" text NOT NULL,
	"pickup_region" text,
	"pickup_postal_code" text NOT NULL,
	"pickup_country" text NOT NULL,
	"pickup_contact_name" text NOT NULL,
	"pickup_contact_phone" text NOT NULL,
	"pickup_notes" text,
	"dropoff_latitude" double precision NOT NULL,
	"dropoff_longitude" double precision NOT NULL,
	"dropoff_location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(dropoff_longitude, dropoff_latitude), 4326)::geography) STORED,
	"dropoff_line1" text NOT NULL,
	"dropoff_line2" text,
	"dropoff_city" text NOT NULL,
	"dropoff_region" text,
	"dropoff_postal_code" text NOT NULL,
	"dropoff_country" text NOT NULL,
	"dropoff_contact_name" text NOT NULL,
	"dropoff_contact_phone" text NOT NULL,
	"dropoff_notes" text,
	"parcel_weight_kg" double precision NOT NULL,
	"parcel_dims_l" double precision,
	"parcel_dims_w" double precision,
	"parcel_dims_h" double precision,
	"parcel_size_class" text NOT NULL,
	"parcel_pieces" integer DEFAULT 1 NOT NULL,
	"parcel_fragile" boolean DEFAULT false NOT NULL,
	"item_description" text NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduling_kind" text DEFAULT 'now' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"distance_m" double precision,
	"quote_ref" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shipments_type_check" CHECK ("shipments"."type" in ('package', 'food', 'move')),
	CONSTRAINT "shipments_status_check" CHECK ("shipments"."status" in ('draft', 'quoting', 'quoted', 'booked', 'cancelled', 'expired')),
	CONSTRAINT "shipments_size_class_check" CHECK ("shipments"."parcel_size_class" in ('small', 'medium', 'large')),
	CONSTRAINT "shipments_scheduling_kind_check" CHECK ("shipments"."scheduling_kind" in ('now', 'scheduled')),
	CONSTRAINT "shipments_scheduling_shape_check" CHECK (("shipments"."scheduling_kind" = 'scheduled' and "shipments"."scheduled_for" is not null)
       or ("shipments"."scheduling_kind" = 'now' and "shipments"."scheduled_for" is null))
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_service_areas" ADD CONSTRAINT "company_service_areas_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_active_vehicle_id_vehicles_id_fk" FOREIGN KEY ("active_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_enforcements" ADD CONSTRAINT "moderation_enforcements_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_context_job_id_jobs_id_fk" FOREIGN KEY ("context_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_location_pings" ADD CONSTRAINT "job_location_pings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_position_idx" ON "categories" USING btree ("parent_id","position");--> statement-breakpoint
CREATE INDEX "categories_ancestor_slugs_idx" ON "categories" USING gin ("ancestor_slugs");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_levels_variant_location_key" ON "inventory_levels" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "listings_status_published_idx" ON "listings" USING btree ("status","published_at","id");--> statement-breakpoint
CREATE INDEX "listings_status_category_published_idx" ON "listings" USING btree ("status","category_id","published_at","id");--> statement-breakpoint
CREATE INDEX "listings_category_slugs_idx" ON "listings" USING gin ("category_slugs");--> statement-breakpoint
CREATE INDEX "listings_status_price_published_idx" ON "listings" USING btree ("status","price_min_amount","published_at");--> statement-breakpoint
CREATE INDEX "listings_store_status_published_idx" ON "listings" USING btree ("owner_type","store_id","status","published_at","id");--> statement-breakpoint
CREATE INDEX "listings_user_status_published_idx" ON "listings" USING btree ("owner_type","oxy_user_id","status","published_at","id");--> statement-breakpoint
CREATE INDEX "listings_location_idx" ON "listings" USING gist ("location");--> statement-breakpoint
CREATE INDEX "listings_search_vector_idx" ON "listings" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "product_variants_listing_position_idx" ON "product_variants" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "product_variants_listing_available_idx" ON "product_variants" USING btree ("listing_id","inventory_available");--> statement-breakpoint
CREATE INDEX "product_variants_sku_idx" ON "product_variants" USING btree ("sku") WHERE "product_variants"."sku" is not null;--> statement-breakpoint
CREATE INDEX "addresses_oxy_user_default_created_idx" ON "addresses" USING btree ("oxy_user_id","is_default","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_variant_key" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_oxy_user_id_key" ON "carts" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "order_items_order_position_idx" ON "order_items" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "order_status_events_order_at_id_idx" ON "order_status_events" USING btree ("order_id","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "orders_buyer_created_idx" ON "orders" USING btree ("buyer_oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_store_status_created_idx" ON "orders" USING btree ("store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "orders_seller_status_created_idx" ON "orders" USING btree ("seller_oxy_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "orders_checkout_group_idx" ON "orders" USING btree ("checkout_group_id");--> statement-breakpoint
CREATE INDEX "orders_payment_status_created_idx" ON "orders" USING btree ("payment_status","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_oxy_user_created_idx" ON "feedback" USING btree ("oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedback_type_idx" ON "feedback" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_oxy_user_token_key" ON "push_tokens" USING btree ("oxy_user_id","token");--> statement-breakpoint
CREATE INDEX "push_tokens_token_idx" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "reviews_target_listing_status_created_idx" ON "reviews" USING btree ("target_type","listing_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_target_store_status_created_idx" ON "reviews" USING btree ("target_type","store_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_target_seller_status_created_idx" ON "reviews" USING btree ("target_type","seller_oxy_user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_author_listing_key" ON "reviews" USING btree ("author_oxy_user_id","listing_id") WHERE "reviews"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_oxy_user_endpoint_key" ON "web_push_subscriptions" USING btree ("oxy_user_id","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "company_members_company_oxy_user_key" ON "company_members" USING btree ("company_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "company_members_oxy_user_idx" ON "company_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "company_service_areas_company_idx" ON "company_service_areas" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_companies_handle_key" ON "courier_companies" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "courier_companies_status_created_idx" ON "courier_companies" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_profiles_oxy_user_key" ON "courier_profiles" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "courier_profiles_location_idx" ON "courier_profiles" USING gist ("location") WHERE "courier_profiles"."location" is not null;--> statement-breakpoint
CREATE INDEX "courier_profiles_online_status_last_ping_idx" ON "courier_profiles" USING btree ("online_status","last_ping_at");--> statement-breakpoint
CREATE INDEX "vehicles_courier_oxy_user_idx" ON "vehicles" USING btree ("courier_oxy_user_id");--> statement-breakpoint
CREATE INDEX "vehicles_company_idx" ON "vehicles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_enforcements_decision_revision_action_key" ON "moderation_enforcements" USING btree ("decision_id","revision","action");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_target_created_idx" ON "moderation_enforcements" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_events_case_received_idx" ON "moderation_events" USING btree ("case_id","received_at") WHERE "moderation_events"."case_id" is not null;--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_status_available_idx" ON "moderation_outboxes" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_status_lease_idx" ON "moderation_outboxes" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_expires_at_idx" ON "moderation_outboxes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_target_key" ON "reports" USING btree ("reporter","reported_type","reported_id");--> statement-breakpoint
CREATE INDEX "reports_local_status_created_idx" ON "reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "reports_crowdsource_case_idx" ON "reports" USING btree ("crowd_source_case_id") WHERE "reports"."crowd_source_case_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_user_status_created_idx" ON "notifications" USING btree ("oxy_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("oxy_user_id","created_at") WHERE "notifications"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "notifications_dismissed_since_idx" ON "notifications" USING btree ("dismissed_since");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_profiles_oxy_user_key" ON "seller_profiles" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_members_store_oxy_user_key" ON "store_members" USING btree ("store_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "store_members_oxy_user_idx" ON "store_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_handle_key" ON "stores" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "stores_status_created_idx" ON "stores" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_location_pings_job_at_idx" ON "job_location_pings" USING btree ("job_id","at","id");--> statement-breakpoint
CREATE INDEX "job_offers_job_status_idx" ON "job_offers" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "job_offers_courier_status_idx" ON "job_offers" USING btree ("courier_oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "job_offers_reapable_since_idx" ON "job_offers" USING btree ("reapable_since");--> statement-breakpoint
CREATE INDEX "job_status_events_job_at_idx" ON "job_status_events" USING btree ("job_id","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs" USING btree ("job_number");--> statement-breakpoint
CREATE INDEX "jobs_sender_created_idx" ON "jobs" USING btree ("sender_oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_courier_status_created_idx" ON "jobs" USING btree ("courier_oxy_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_type_idx" ON "jobs" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "jobs_shipment_idx" ON "jobs" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs" USING btree ("idempotency_key") WHERE "jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "providers_key_key" ON "providers" USING btree ("key");--> statement-breakpoint
CREATE INDEX "providers_enabled_idx" ON "providers" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "quotes_shipment_status_idx" ON "quotes" USING btree ("shipment_id","status");--> statement-breakpoint
CREATE INDEX "quotes_expires_at_idx" ON "quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "shipments_pickup_location_idx" ON "shipments" USING gist ("pickup_location");--> statement-breakpoint
CREATE INDEX "shipments_dropoff_location_idx" ON "shipments" USING gist ("dropoff_location");--> statement-breakpoint
CREATE INDEX "shipments_sender_created_idx" ON "shipments" USING btree ("sender_oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "shipments_status_type_idx" ON "shipments" USING btree ("status","type");
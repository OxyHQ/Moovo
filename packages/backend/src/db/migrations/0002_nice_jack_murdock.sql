-- oxy:deploy-phase=pre
--
-- Moovo Tracker: the five tables universal parcel tracking runs on.
--
-- Purely additive — five new tables, their constraints and their indexes. The
-- image currently serving reads and writes none of them, so this can land
-- before the rollout that uses it.
--
-- `tracking_carriers.key` is a UNIQUE CONSTRAINT rather than the unique INDEX
-- `providers.key` uses, and that is not a style choice: it is the target of
-- `tracked_parcels.carrier_key`'s foreign key, and a constraint lands inside
-- CREATE TABLE while an index is a separate statement that drizzle emits AFTER
-- the ALTER TABLE … ADD CONSTRAINT block below.
CREATE TABLE "tracked_parcel_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"parcel_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"entered_number" text NOT NULL,
	"title" text,
	"notify_on_state_change" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"last_notified_checkpoint_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_parcels" (
	"id" text PRIMARY KEY NOT NULL,
	"carrier_key" text NOT NULL,
	"tracking_number" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_status" text,
	"service_name" text,
	"origin_country" text,
	"destination_country" text,
	"destination_postal_code" text,
	"estimated_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_checkpoint_at" timestamp with time zone,
	"checkpoint_count" integer DEFAULT 0 NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"poll_mode" text DEFAULT 'poll' NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"not_found_streak" integer DEFAULT 0 NOT NULL,
	"last_poll_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"moovo_job_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tracked_parcels_status_check" CHECK ("tracked_parcels"."status" in ('pending', 'info_received', 'in_transit', 'out_for_delivery', 'available_for_pickup', 'delivered', 'failed_attempt', 'exception', 'returned', 'expired', 'cancelled')),
	CONSTRAINT "tracked_parcels_poll_mode_check" CHECK ("tracked_parcels"."poll_mode" in ('poll', 'webhook', 'deeplink', 'manual')),
	CONSTRAINT "tracked_parcels_number_normalised_check" CHECK ("tracked_parcels"."tracking_number" = upper("tracked_parcels"."tracking_number") and "tracked_parcels"."tracking_number" !~ '[^A-Z0-9]'),
	CONSTRAINT "tracked_parcels_deeplink_no_poll_check" CHECK ("tracked_parcels"."poll_mode" <> 'deeplink' or "tracked_parcels"."next_poll_at" is null),
	CONSTRAINT "tracked_parcels_moovo_job_shape_check" CHECK ("tracked_parcels"."moovo_job_id" is null or "tracked_parcels"."carrier_key" = 'moovo'),
	CONSTRAINT "tracked_parcels_poll_error_length_check" CHECK ("tracked_parcels"."last_poll_error" is null or char_length("tracked_parcels"."last_poll_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "tracking_carriers" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"logo_file_id" text,
	"provider_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"source_kind" text DEFAULT 'deep_link_only' NOT NULL,
	"poll_supported" boolean DEFAULT false NOT NULL,
	"webhook_supported" boolean DEFAULT false NOT NULL,
	"deep_link_template" text NOT NULL,
	"country_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_calls_per_minute" integer,
	"max_calls_per_day" integer,
	"max_concurrent" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tracking_carriers_key_key" UNIQUE("key"),
	CONSTRAINT "tracking_carriers_source_kind_check" CHECK ("tracking_carriers"."source_kind" in ('official_api', 'public_page', 'deep_link_only'))
);
--> statement-breakpoint
CREATE TABLE "tracking_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"parcel_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"raw_status" text,
	"description" text,
	"location_text" text,
	"country_code" text,
	"latitude" double precision,
	"longitude" double precision,
	"location" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"occurred_at" timestamp with time zone NOT NULL,
	"occurred_at_is_local" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tracking_checkpoints_status_check" CHECK ("tracking_checkpoints"."status" in ('pending', 'info_received', 'in_transit', 'out_for_delivery', 'available_for_pickup', 'delivered', 'failed_attempt', 'exception', 'returned', 'expired', 'cancelled')),
	CONSTRAINT "tracking_checkpoints_location_shape_check" CHECK (("tracking_checkpoints"."latitude" is null) = ("tracking_checkpoints"."longitude" is null)),
	CONSTRAINT "tracking_checkpoints_description_length_check" CHECK ("tracking_checkpoints"."description" is null or char_length("tracking_checkpoints"."description") <= 1000),
	CONSTRAINT "tracking_checkpoints_location_text_length_check" CHECK ("tracking_checkpoints"."location_text" is null or char_length("tracking_checkpoints"."location_text") <= 300)
);
--> statement-breakpoint
CREATE TABLE "tracking_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"carrier_key" text NOT NULL,
	"type" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tracking_webhook_events_state_check" CHECK ("tracking_webhook_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "tracked_parcel_subscriptions" ADD CONSTRAINT "tracked_parcel_subscriptions_parcel_id_tracked_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."tracked_parcels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_parcels" ADD CONSTRAINT "tracked_parcels_carrier_key_tracking_carriers_key_fk" FOREIGN KEY ("carrier_key") REFERENCES "public"."tracking_carriers"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_parcels" ADD CONSTRAINT "tracked_parcels_moovo_job_id_jobs_id_fk" FOREIGN KEY ("moovo_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_carriers" ADD CONSTRAINT "tracking_carriers_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_checkpoints" ADD CONSTRAINT "tracking_checkpoints_parcel_id_tracked_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."tracked_parcels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_parcel_subscriptions_user_parcel_key" ON "tracked_parcel_subscriptions" USING btree ("oxy_user_id","parcel_id");--> statement-breakpoint
CREATE INDEX "tracked_parcel_subscriptions_user_idx" ON "tracked_parcel_subscriptions" USING btree ("oxy_user_id","archived_at","created_at");--> statement-breakpoint
CREATE INDEX "tracked_parcel_subscriptions_parcel_idx" ON "tracked_parcel_subscriptions" USING btree ("parcel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_parcels_carrier_number_key" ON "tracked_parcels" USING btree ("carrier_key","tracking_number");--> statement-breakpoint
CREATE INDEX "tracked_parcels_due_idx" ON "tracked_parcels" USING btree ("next_poll_at") WHERE "tracked_parcels"."next_poll_at" is not null;--> statement-breakpoint
CREATE INDEX "tracked_parcels_carrier_due_idx" ON "tracked_parcels" USING btree ("carrier_key","next_poll_at") WHERE "tracked_parcels"."next_poll_at" is not null;--> statement-breakpoint
CREATE INDEX "tracked_parcels_lease_idx" ON "tracked_parcels" USING btree ("lease_until") WHERE "tracked_parcels"."lease_until" is not null;--> statement-breakpoint
CREATE INDEX "tracked_parcels_job_idx" ON "tracked_parcels" USING btree ("moovo_job_id") WHERE "tracked_parcels"."moovo_job_id" is not null;--> statement-breakpoint
CREATE INDEX "tracked_parcels_expires_at_idx" ON "tracked_parcels" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tracking_carriers_enabled_idx" ON "tracking_carriers" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_checkpoints_dedupe_key" ON "tracking_checkpoints" USING btree ("parcel_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "tracking_checkpoints_parcel_at_idx" ON "tracking_checkpoints" USING btree ("parcel_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "tracking_webhook_events_carrier_received_idx" ON "tracking_webhook_events" USING btree ("carrier_key","received_at");--> statement-breakpoint
CREATE INDEX "tracking_webhook_events_expires_at_idx" ON "tracking_webhook_events" USING btree ("expires_at");
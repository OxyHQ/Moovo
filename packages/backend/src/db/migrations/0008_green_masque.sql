-- oxy:deploy-phase=pre
CREATE TABLE "material_transports" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"requesting_account_id" text NOT NULL,
	"payer_account_id" text NOT NULL,
	"donor_account_id" text NOT NULL,
	"recipient_account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"shipment_id" text NOT NULL,
	"status" text DEFAULT 'quoting' NOT NULL,
	"authorized_quote_id" text,
	"authorized_amount_minor" bigint,
	"authorized_actor_account_id" text,
	"authorization_expires_at" timestamp with time zone,
	"authorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "material_transports_status_check" CHECK ("material_transports"."status" in ('quoting', 'quoted', 'authorized', 'booking', 'booking_unknown', 'booked', 'cancelled')),
	CONSTRAINT "material_transports_authorization_shape" CHECK (("material_transports"."authorized_quote_id" is null and "material_transports"."authorized_amount_minor" is null and "material_transports"."authorized_actor_account_id" is null and "material_transports"."authorization_expires_at" is null and "material_transports"."authorized_at" is null) or ("material_transports"."authorized_quote_id" is not null and "material_transports"."authorized_amount_minor" between 0 and 9007199254740991 and "material_transports"."authorized_actor_account_id" is not null and "material_transports"."authorization_expires_at" is not null and "material_transports"."authorized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "shipment_booking_attempts" (
	"shipment_id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"sender_account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"status" text NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shipment_booking_attempts_status_check" CHECK ("shipment_booking_attempts"."status" in ('processing', 'unknown', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "material_transports" ADD CONSTRAINT "material_transports_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD CONSTRAINT "shipment_booking_attempts_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD CONSTRAINT "shipment_booking_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "material_transports_reservation_key" ON "material_transports" USING btree ("reservation_id") WHERE "material_transports"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "material_transports_operation_key" ON "material_transports" USING btree ("requesting_account_id","operation_id");
-- oxy:deploy-phase=pre
-- Widens the claim states with `failed` (the old image never writes it),
-- numbers attempts so a definitely-failed carrier booking is retried under a
-- fresh operation id, and freezes the carrier and price on an external claim.
-- Additive; the table holds one row per booked shipment.
ALTER TABLE "shipment_booking_attempts" DROP CONSTRAINT "shipment_booking_attempts_status_check";--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD COLUMN "price_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "shipment_booking_attempts" ADD CONSTRAINT "shipment_booking_attempts_status_check" CHECK ("shipment_booking_attempts"."status" in ('processing', 'unknown', 'failed', 'completed'));
-- oxy:deploy-phase=pre
ALTER TABLE "shipment_booking_attempts" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_booking_attempts_idempotency_key" ON "shipment_booking_attempts" USING btree ("idempotency_key") WHERE "shipment_booking_attempts"."idempotency_key" is not null;

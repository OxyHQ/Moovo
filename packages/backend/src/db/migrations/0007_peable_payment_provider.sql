-- oxy:deploy-phase=post
--
-- The Peable-writing revision is now live. Rewrite every surviving legacy
-- value before narrowing the constraints so no active row retains the retired
-- provider identifier.
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "courier_companies" DROP CONSTRAINT "courier_companies_payout_provider_check";--> statement-breakpoint
ALTER TABLE "courier_profiles" DROP CONSTRAINT "courier_profiles_payout_provider_check";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_payment_provider_check";--> statement-breakpoint
UPDATE "orders" SET "payment_provider" = 'peable' WHERE "payment_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "courier_companies" SET "payout_provider" = 'peable' WHERE "payout_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "courier_profiles" SET "payout_provider" = 'peable' WHERE "payout_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "jobs" SET "payment_provider" = 'peable' WHERE "payment_provider" = 'oxy_pay';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "courier_companies" ADD CONSTRAINT "courier_companies_payout_provider_check" CHECK ("courier_companies"."payout_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_payout_provider_check" CHECK ("courier_profiles"."payout_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payment_provider_check" CHECK ("jobs"."payment_provider" in ('peable'));

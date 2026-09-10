-- oxy:deploy-phase=pre
-- The previous image has no explicit `oxy_pay` writer: all four columns use
-- database defaults and hydration treats the provider as an opaque stored
-- value. Renaming rows before rollout is therefore backwards-compatible while
-- ensuring both old and new tasks observe one canonical identifier.
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "courier_companies" DROP CONSTRAINT "courier_companies_payout_provider_check";--> statement-breakpoint
ALTER TABLE "courier_profiles" DROP CONSTRAINT "courier_profiles_payout_provider_check";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_payment_provider_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "courier_companies" ALTER COLUMN "payout_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "courier_profiles" ALTER COLUMN "payout_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "payment_provider" SET DEFAULT 'peable';--> statement-breakpoint
UPDATE "orders" SET "payment_provider" = 'peable' WHERE "payment_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "courier_companies" SET "payout_provider" = 'peable' WHERE "payout_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "courier_profiles" SET "payout_provider" = 'peable' WHERE "payout_provider" = 'oxy_pay';--> statement-breakpoint
UPDATE "jobs" SET "payment_provider" = 'peable' WHERE "payment_provider" = 'oxy_pay';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "courier_companies" ADD CONSTRAINT "courier_companies_payout_provider_check" CHECK ("courier_companies"."payout_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_payout_provider_check" CHECK ("courier_profiles"."payout_provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payment_provider_check" CHECK ("jobs"."payment_provider" in ('peable'));

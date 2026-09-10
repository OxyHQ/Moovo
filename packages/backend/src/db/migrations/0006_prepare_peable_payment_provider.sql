-- oxy:deploy-phase=pre
--
-- Widen the four persisted payment-provider contracts before the application
-- starts writing `peable`. The retired value remains temporarily valid so the
-- previous task revision can continue serving throughout the rolling deploy.
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "courier_companies" DROP CONSTRAINT "courier_companies_payout_provider_check";--> statement-breakpoint
ALTER TABLE "courier_profiles" DROP CONSTRAINT "courier_profiles_payout_provider_check";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_payment_provider_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "courier_companies" ALTER COLUMN "payout_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "courier_profiles" ALTER COLUMN "payout_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "payment_provider" SET DEFAULT 'peable';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('oxy_pay', 'peable'));--> statement-breakpoint
ALTER TABLE "courier_companies" ADD CONSTRAINT "courier_companies_payout_provider_check" CHECK ("courier_companies"."payout_provider" in ('oxy_pay', 'peable'));--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_payout_provider_check" CHECK ("courier_profiles"."payout_provider" in ('oxy_pay', 'peable'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payment_provider_check" CHECK ("jobs"."payment_provider" in ('oxy_pay', 'peable'));

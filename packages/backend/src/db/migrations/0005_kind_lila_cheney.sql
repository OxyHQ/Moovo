-- oxy:deploy-phase=pre
--
-- Give an externally fulfilled job somewhere to keep the carrier's tracking
-- number and page.
--
-- Purely additive: two nullable columns. The previous image writes neither and
-- reads neither, so this lands ahead of the rollout that fills them.
--
-- Until now `ProviderAdapter.book` returned `trackingUrl` and `job.service.ts`
-- kept only `bookingRef` — there was nowhere to put it. Moovo was discarding
-- the one thing a customer wants when DHL is carrying their parcel.
ALTER TABLE "jobs" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "tracking_url" text;
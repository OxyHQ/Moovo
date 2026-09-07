-- oxy:deploy-phase=pre
--
-- Widen `notifications_type_check` for the five Moovo Tracker notification
-- types.
--
-- `pre`, and the DROP is not what it looks like: the new value set is a strict
-- SUPERSET of the old one, so nothing the currently-serving image can write
-- becomes invalid. Drizzle expresses a CHECK change as drop-then-add, and the
-- migration runs inside one transaction, so the table is never observably
-- unconstrained.
--
-- The tuple and this migration have to land together. A tuple-only change makes
-- every insert of a new type fail with 23514 at runtime, and only where a real
-- database exists — which is to say, not in any mocked test.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'listing_sold', 'review_received', 'store_member_invited', 'low_inventory', 'company_member_invited', 'job_offered', 'job_accepted', 'job_picked_up', 'job_in_transit', 'job_delivered', 'job_cancelled', 'dispatch_no_courier', 'tracking_update', 'tracking_out_for_delivery', 'tracking_delivered', 'tracking_exception', 'tracking_available_for_pickup'));
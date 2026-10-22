-- oxy:deploy-phase=pre
-- Widens the file event type checks with `file.lost` (oxy ADR 0043 D13); the previous image never writes it.
ALTER TABLE "file_event_receipts" DROP CONSTRAINT "file_event_receipts_type_check";--> statement-breakpoint
ALTER TABLE "file_takedown_actions" DROP CONSTRAINT "file_takedown_actions_event_type_check";--> statement-breakpoint
ALTER TABLE "file_event_receipts" ADD CONSTRAINT "file_event_receipts_type_check" CHECK ("file_event_receipts"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));--> statement-breakpoint
ALTER TABLE "file_takedown_actions" ADD CONSTRAINT "file_takedown_actions_event_type_check" CHECK ("file_takedown_actions"."event_type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));
-- oxy:deploy-phase=pre
CREATE TABLE "file_event_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_event_receipts_type_check" CHECK ("file_event_receipts"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked'))
);
--> statement-breakpoint
CREATE TABLE "file_reference_reconciliations" (
	"entity_type" text PRIMARY KEY NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_reference_reconciliations_entity_type_check" CHECK ("file_reference_reconciliations"."entity_type" in ('category', 'listing', 'store', 'courier_company', 'shipment', 'job', 'provider', 'tracking_carrier', 'order_item'))
);
--> statement-breakpoint
CREATE TABLE "file_reference_syncs" (
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"file_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_reference_syncs_pkey" PRIMARY KEY("entity_type","entity_id","file_id"),
	CONSTRAINT "file_reference_syncs_entity_type_check" CHECK ("file_reference_syncs"."entity_type" in ('category', 'listing', 'store', 'courier_company', 'shipment', 'job', 'provider', 'tracking_carrier', 'order_item'))
);
--> statement-breakpoint
CREATE TABLE "file_takedown_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"action" text NOT NULL,
	"position" integer,
	"reverts_action_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_takedown_actions_entity_type_check" CHECK ("file_takedown_actions"."entity_type" in ('category', 'listing', 'store', 'courier_company', 'shipment', 'job', 'provider', 'tracking_carrier', 'order_item')),
	CONSTRAINT "file_takedown_actions_event_type_check" CHECK ("file_takedown_actions"."event_type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked')),
	CONSTRAINT "file_takedown_actions_field_check" CHECK ("file_takedown_actions"."field" in ('image_file_id', 'images', 'logo_file_id', 'cover_file_id', 'photos', 'pod_photo_file_id', 'pod_signature_file_id')),
	CONSTRAINT "file_takedown_actions_action_check" CHECK ("file_takedown_actions"."action" in ('cleared', 'restored', 'restore_skipped'))
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "image_file_id" text;--> statement-breakpoint
ALTER TABLE "file_takedown_actions" ADD CONSTRAINT "file_takedown_actions_reverts_action_id_file_takedown_actions_id_fk" FOREIGN KEY ("reverts_action_id") REFERENCES "public"."file_takedown_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_event_receipts_expires_idx" ON "file_event_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "file_reference_syncs_available_idx" ON "file_reference_syncs" USING btree ("available_at");--> statement-breakpoint
CREATE INDEX "file_reference_syncs_file_idx" ON "file_reference_syncs" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_takedown_actions_file_idx" ON "file_takedown_actions" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_takedown_actions_reverts_key" ON "file_takedown_actions" USING btree ("reverts_action_id") WHERE "file_takedown_actions"."reverts_action_id" is not null;
--> statement-breakpoint
-- Hand-written below this line (drizzle-kit does not model functions or
-- triggers). A regeneration of this file DROPS everything here; diff it.
--
-- THE one definition of which Oxy files a Moovo row uses. The triggers, the
-- sync worker, the nightly reconciliation inventory and the takedown handler
-- all call it, so "which columns hold a file" is spelled exactly once. A value
-- that cannot be an Oxy file id (a hotlinked URL from before ADR 0043, an empty
-- string) is not a use: Oxy's reference routes refuse ids over 64 characters
-- and would fail the whole batch it rode in. An unknown entity type RAISES —
-- answering "no files" for a type nobody taught this function would make its
-- references look stale and be removed.
CREATE FUNCTION moovo_entity_file_ids(p_entity_type text, p_row jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_columns text[];
  v_array_column text;
  v_ids text[];
BEGIN
  CASE p_entity_type
    WHEN 'category' THEN v_columns := ARRAY['image_file_id'];
    WHEN 'order_item' THEN v_columns := ARRAY['image_file_id'];
    WHEN 'store' THEN v_columns := ARRAY['logo_file_id', 'cover_file_id'];
    WHEN 'courier_company' THEN v_columns := ARRAY['cover_file_id'];
    WHEN 'job' THEN v_columns := ARRAY['pod_photo_file_id', 'pod_signature_file_id'];
    WHEN 'provider' THEN v_columns := ARRAY['logo_file_id'];
    WHEN 'tracking_carrier' THEN v_columns := ARRAY['logo_file_id'];
    WHEN 'listing' THEN v_columns := '{}'; v_array_column := 'images';
    WHEN 'shipment' THEN v_columns := '{}'; v_array_column := 'photos';
    ELSE RAISE EXCEPTION 'moovo_entity_file_ids: unknown entity type %', p_entity_type;
  END CASE;

  SELECT coalesce(array_agg(DISTINCT f ORDER BY f), '{}'::text[]) INTO v_ids
  FROM (
    SELECT p_row ->> c AS f FROM unnest(v_columns) AS c
    UNION ALL
    SELECT e ->> 'fileId'
    FROM jsonb_array_elements(
      CASE WHEN v_array_column IS NOT NULL AND jsonb_typeof(p_row -> v_array_column) = 'array'
        THEN p_row -> v_array_column ELSE '[]'::jsonb END
    ) AS e
  ) AS used
  WHERE f ~ '^[A-Za-z0-9_-]{1,64}$';
  RETURN v_ids;
END $$;
--> statement-breakpoint
-- "Look again at (entity, file)". A repeat bumps `generation` so a worker
-- holding the row cannot delete the newer request when it finishes the older.
CREATE FUNCTION moovo_enqueue_file_reference_syncs(p_entity_type text, p_entity_id text, p_file_ids text[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO file_reference_syncs AS s (entity_type, entity_id, file_id)
  SELECT p_entity_type, p_entity_id, f FROM (SELECT DISTINCT unnest(p_file_ids) AS f) AS ids
  ON CONFLICT (entity_type, entity_id, file_id) DO UPDATE
    SET generation = s.generation + 1,
        available_at = now(),
        attempts = 0,
        last_error = NULL,
        updated_at = date_trunc('milliseconds', now())
$$;
--> statement-breakpoint
-- Every write to a file-bearing table enqueues the files whose use it CHANGED
-- (added or removed), in the writer's own transaction. Unchanged files enqueue
-- nothing, so an UPDATE that rewrites a column with the same value is free.
CREATE FUNCTION moovo_file_references_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_type text := TG_ARGV[0];
  v_old text[] := '{}';
  v_new text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM moovo_enqueue_file_reference_syncs(v_type, NEW.id, moovo_entity_file_ids(v_type, to_jsonb(NEW)));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM moovo_enqueue_file_reference_syncs(v_type, OLD.id, moovo_entity_file_ids(v_type, to_jsonb(OLD)));
  ELSE
    v_old := moovo_entity_file_ids(v_type, to_jsonb(OLD));
    v_new := moovo_entity_file_ids(v_type, to_jsonb(NEW));
    IF OLD.id IS DISTINCT FROM NEW.id THEN
      PERFORM moovo_enqueue_file_reference_syncs(v_type, OLD.id, v_old);
      PERFORM moovo_enqueue_file_reference_syncs(v_type, NEW.id, v_new);
    ELSE
      PERFORM moovo_enqueue_file_reference_syncs(
        v_type,
        NEW.id,
        ARRAY(
          (SELECT unnest(v_old) EXCEPT SELECT unnest(v_new))
          UNION
          (SELECT unnest(v_new) EXCEPT SELECT unnest(v_old))
        )
      );
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER categories_file_references_insert_delete AFTER INSERT OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('category');
--> statement-breakpoint
CREATE TRIGGER categories_file_references_update AFTER UPDATE ON categories FOR EACH ROW WHEN (OLD.image_file_id IS DISTINCT FROM NEW.image_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('category');
--> statement-breakpoint
CREATE TRIGGER listings_file_references_insert_delete AFTER INSERT OR DELETE ON listings FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('listing');
--> statement-breakpoint
CREATE TRIGGER listings_file_references_update AFTER UPDATE ON listings FOR EACH ROW WHEN (OLD.images IS DISTINCT FROM NEW.images OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('listing');
--> statement-breakpoint
CREATE TRIGGER stores_file_references_insert_delete AFTER INSERT OR DELETE ON stores FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('store');
--> statement-breakpoint
CREATE TRIGGER stores_file_references_update AFTER UPDATE ON stores FOR EACH ROW WHEN (OLD.logo_file_id IS DISTINCT FROM NEW.logo_file_id OR OLD.cover_file_id IS DISTINCT FROM NEW.cover_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('store');
--> statement-breakpoint
CREATE TRIGGER courier_companies_file_references_insert_delete AFTER INSERT OR DELETE ON courier_companies FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('courier_company');
--> statement-breakpoint
CREATE TRIGGER courier_companies_file_references_update AFTER UPDATE ON courier_companies FOR EACH ROW WHEN (OLD.cover_file_id IS DISTINCT FROM NEW.cover_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('courier_company');
--> statement-breakpoint
CREATE TRIGGER shipments_file_references_insert_delete AFTER INSERT OR DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('shipment');
--> statement-breakpoint
CREATE TRIGGER shipments_file_references_update AFTER UPDATE ON shipments FOR EACH ROW WHEN (OLD.photos IS DISTINCT FROM NEW.photos OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('shipment');
--> statement-breakpoint
CREATE TRIGGER jobs_file_references_insert_delete AFTER INSERT OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('job');
--> statement-breakpoint
CREATE TRIGGER jobs_file_references_update AFTER UPDATE ON jobs FOR EACH ROW WHEN (OLD.pod_photo_file_id IS DISTINCT FROM NEW.pod_photo_file_id OR OLD.pod_signature_file_id IS DISTINCT FROM NEW.pod_signature_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('job');
--> statement-breakpoint
CREATE TRIGGER providers_file_references_insert_delete AFTER INSERT OR DELETE ON providers FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('provider');
--> statement-breakpoint
CREATE TRIGGER providers_file_references_update AFTER UPDATE ON providers FOR EACH ROW WHEN (OLD.logo_file_id IS DISTINCT FROM NEW.logo_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('provider');
--> statement-breakpoint
CREATE TRIGGER tracking_carriers_file_references_insert_delete AFTER INSERT OR DELETE ON tracking_carriers FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('tracking_carrier');
--> statement-breakpoint
CREATE TRIGGER tracking_carriers_file_references_update AFTER UPDATE ON tracking_carriers FOR EACH ROW WHEN (OLD.logo_file_id IS DISTINCT FROM NEW.logo_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('tracking_carrier');
--> statement-breakpoint
CREATE TRIGGER order_items_file_references_insert_delete AFTER INSERT OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION moovo_file_references_changed('order_item');
--> statement-breakpoint
CREATE TRIGGER order_items_file_references_update AFTER UPDATE ON order_items FOR EACH ROW WHEN (OLD.image_file_id IS DISTINCT FROM NEW.image_file_id OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION moovo_file_references_changed('order_item');
--> statement-breakpoint
-- An order line used to freeze a resolved CDN URL (`https://cloud.oxy.so/<id>?variant=thumb`).
-- Recover the file id from every such row; the trigger above enqueues each one.
-- Migration 0012 (post) runs this again for lines the previous image wrote
-- during the rollout, then drops `image_url`.
UPDATE order_items
SET image_file_id = substring(image_url from '^https://cloud\.oxy\.so/([A-Za-z0-9_-]{1,64})(?:[?#]|$)')
WHERE image_file_id IS NULL AND image_url IS NOT NULL;

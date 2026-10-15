-- oxy:deploy-phase=pre
CREATE TABLE "courier_company_identity_archives" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"observed_name" text NOT NULL,
	"logo_file_id" text,
	"archived_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "courier_companies" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_companies" ADD COLUMN "oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "courier_company_identity_archives" ADD CONSTRAINT "courier_company_identity_archives_company_id_courier_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."courier_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_company_identity_archives_company_key" ON "courier_company_identity_archives" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_companies_oxy_account_key" ON "courier_companies" USING btree ("oxy_account_id");
--> statement-breakpoint
INSERT INTO courier_company_identity_archives(id,company_id,observed_name,logo_file_id)
SELECT id,id,name,logo_file_id FROM courier_companies;
--> statement-breakpoint
CREATE FUNCTION moovo_company_identity_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.oxy_account_id IS NULL OR NEW.name IS NOT NULL OR NEW.logo_file_id IS NOT NULL THEN RAISE EXCEPTION 'Fleet registration requires canonical Oxy identity'; END IF;
 ELSIF ROW(NEW.name,NEW.logo_file_id) IS DISTINCT FROM ROW(OLD.name,OLD.logo_file_id) THEN RAISE EXCEPTION 'Company identity is owned by Oxy';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER company_identity_frozen BEFORE INSERT OR UPDATE ON courier_companies FOR EACH ROW EXECUTE FUNCTION moovo_company_identity_frozen();
--> statement-breakpoint
CREATE FUNCTION moovo_company_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Company source evidence is immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER company_archive_immutable BEFORE UPDATE OR DELETE ON courier_company_identity_archives FOR EACH ROW EXECUTE FUNCTION moovo_company_archive_immutable();

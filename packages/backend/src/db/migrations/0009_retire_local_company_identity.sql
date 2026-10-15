-- oxy:deploy-phase=post
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM courier_companies WHERE oxy_account_id IS NULL) THEN RAISE EXCEPTION 'Unmapped fleet references: review and apply organization mappings before identity cutover'; END IF;
 IF EXISTS (SELECT 1 FROM courier_companies c LEFT JOIN courier_company_identity_archives a ON a.company_id=c.id WHERE c.name IS NOT NULL AND (a.id IS NULL OR ROW(c.name,c.logo_file_id) IS DISTINCT FROM ROW(a.observed_name,a.logo_file_id))) THEN RAISE EXCEPTION 'Company source archive missing or changed'; END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER company_identity_frozen ON courier_companies;
--> statement-breakpoint
DROP FUNCTION moovo_company_identity_frozen();
--> statement-breakpoint
ALTER TABLE "courier_companies" ALTER COLUMN "oxy_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "courier_companies" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "courier_companies" DROP COLUMN "logo_file_id";
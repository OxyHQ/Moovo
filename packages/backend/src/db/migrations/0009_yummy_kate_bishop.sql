-- oxy:deploy-phase=pre
ALTER TABLE "material_transports" ADD CONSTRAINT "material_transports_authorized_amount_present" CHECK ("material_transports"."authorized_quote_id" is null or "material_transports"."authorized_amount_minor" is not null);

-- oxy:deploy-phase=post
-- Lines the previous image wrote between 0011 and now still carry only the
-- frozen URL: recover their file id exactly as 0011 did before the column goes.
UPDATE order_items
SET image_file_id = substring(image_url from '^https://cloud\.oxy\.so/([A-Za-z0-9_-]{1,64})(?:[?#]|$)')
WHERE image_file_id IS NULL AND image_url IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" DROP COLUMN "image_url";

-- oxy:deploy-phase=pre
--
-- The `moovo` tracking carrier, seeded as part of the schema rather than at
-- boot.
--
-- Every other row in `tracking_carriers` is catalogue: an operator adds,
-- disables and retunes them, and `seedTrackingCarriers` creates them once and
-- then never touches them again. THIS one is structural. `tracked_parcels`
-- carries a foreign key to `tracking_carriers.key`, and booking a job now
-- writes a pointer row on `carrier_key = 'moovo'` inside the job's own
-- transaction — so if this row is absent, the foreign key fails and BOOKING
-- FAILS. Not the tracker: booking.
--
-- Leaving it to the boot-time seed would make that a race between a deploy and
-- its first customer, and would break every test database that migrates without
-- running the seed. A migration is what guarantees the target exists everywhere
-- the schema does.
--
-- A literal id rather than a generated one, deliberately: this is one row with
-- one meaning, and it should be the same row in every database.
--
-- `DO NOTHING` so an operator's later edits to the name or the link survive,
-- exactly as `seedTrackingCarriers` does for the rest of the catalogue.
INSERT INTO "tracking_carriers" ("id", "key", "name", "source_kind", "deep_link_template", "country_codes")
VALUES (
  'moovo-tracking-carrier',
  'moovo',
  'Moovo',
  'deep_link_only',
  'https://tracker.moovo.now/track/{number}',
  '{"ES"}'::text[]
)
ON CONFLICT ("key") DO NOTHING;

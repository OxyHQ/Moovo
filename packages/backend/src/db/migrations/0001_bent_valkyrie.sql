-- oxy:deploy-phase=pre
--
-- Stem listing TAGS as well as storing them verbatim, so a tag is findable by
-- the word a user actually types.
--
-- `pre`, not `post`: nothing is dropped, renamed or narrowed, and the running
-- image keeps reading the same column through the same index. It simply starts
-- matching more. There is no write of the previous image for a `post` statement
-- to break.
--
-- ## Hand-written, and NOT what `drizzle-kit generate` emitted
--
-- drizzle-kit emits `DROP COLUMN` + `ADD COLUMN` for any change to a generated
-- column's expression. Measured on the real server: that silently destroys
-- `listings_search_vector_idx`, because dropping a column drops the indexes
-- over it and drizzle does not re-emit the index (its snapshot never saw the
-- index change). Full-text search would keep returning CORRECT results, by
-- sequential scan, getting slower as the catalogue grows — nothing errors, so
-- nothing would have reported it.
--
-- `ALTER COLUMN ... SET EXPRESSION` keeps the column and its index, and
-- rewrites every existing row. Verified on the server: the index survives and
-- stored rows are recomputed. It needs PostgreSQL 17 — local is 17.5, the
-- shared RDS instance is 17.9.
--
-- If this migration is ever REGENERATED, drizzle will replace it with the
-- destructive pair again. Re-apply both statements below and re-check that
-- `listings_search_vector_idx` still exists afterwards.

-- `array_to_string` is STABLE, not IMMUTABLE, so the server refuses it inside a
-- generated column ("generation expression is not immutable") — as it refuses
-- `tags::text`. Joining a `text[]` with a constant separator really is
-- immutable; the built-in is marked stable only because an arbitrary element
-- type's output function need not be. This wrapper states that for `text[]`
-- alone, which is the only type it accepts.
CREATE OR REPLACE FUNCTION moovo_tags_text(text[]) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
  RETURN array_to_string($1, ' ');
--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "search_vector" SET EXPRESSION AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')) || array_to_tsvector(coalesce(tags, '{}')) || to_tsvector('english', moovo_tags_text(coalesce(tags, '{}'))));

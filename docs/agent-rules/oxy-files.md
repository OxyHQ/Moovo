<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Oxy Files

Every image is an Oxy file (oxy ADR 0043); the model, entity types and setup
are in `docs/oxy-files.md`. Rules that fail silently:

- **A file id from a client is attached only through `assertFilesAttachable`**
  (`services/files/file-ownership.ts`), which every file-accepting service
  function forces by taking a `FileAuthority`. Never store a client's file id
  any other way: it is somebody else's photo, or a hotlink.
- **`resolveMedia` resolves Oxy file ids and nothing else.** Never reintroduce
  a URL pass-through, and never store a resolved URL in a row (`order_items`
  stores the file id since migration 0011).
- **Which columns hold a file is spelled ONCE, in `moovo_entity_file_ids()`
  (migration 0011)**, plus `ENTITY_FILE_SLOTS` for the takedown, held equal by
  `file-references.realdb.test.ts`. A new file column needs both, a
  `*_file_references` trigger pair and an `entityType` — in a hand-written
  migration tail that a regeneration DROPS; diff it.
- **`/webhooks/oxy/files` stays mounted before `express.json()`**, its raw
  parser scoped to that path, like the CrowdSource and carrier webhooks.

**Env:** `OXY_FILES_WEBHOOK_SECRET` (+ `_PREVIOUS` while rotating),
`OXY_FILE_REFERENCES_ENABLED` (default on), `OXY_FILE_REFERENCE_RECONCILE_DRY_RUN`,
`OXY_FILE_REFERENCE_RECONCILE_HOUR_UTC`, `OXY_FILE_REFERENCE_SYNC_*`,
`MAX_PHOTOS_PER_SHIPMENT`.


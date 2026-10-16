# Oxy Files in Moovo

Moovo stores no image bytes. Every image it shows is an **Oxy file**, and since
oxy ADR 0043 ("Who owns a file, who uses it, and when it goes away",
`docs/adr/0043-application-owned-files.md` in the oxy repository) Moovo
tells Oxy which of its rows use which files, keeps that in step, and reacts
when Oxy reports that a file was taken down or deleted.

## Who owns what

| Entity type (`entityType`) | Moovo row → column(s) | File owner |
|---|---|---|
| `category` | `categories.image_file_id` | **the Moovo application** (imported by URL) |
| `listing` | `listings.images[].fileId` | the seller (a person), or a store member |
| `store` | `stores.logo_file_id`, `cover_file_id` | the store member who chose it |
| `courier_company` | `courier_companies.cover_file_id` | the fleet's Oxy organization account (or its administrator) |
| `shipment` | `shipments.photos[].fileId` | the sender |
| `job` | `jobs.pod_photo_file_id`, `pod_signature_file_id` | the courier |
| `provider` | `providers.logo_file_id` | set by operators; the Moovo application |
| `tracking_carrier` | `tracking_carriers.logo_file_id` | set by operators; the Moovo application |
| `order_item` | `order_items.image_file_id` | the listing's seller (the line keeps showing the photo it was bought with) |

`courier_company_identity_archives.logo_file_id` is provenance — the id a
retired directory once showed — and is never resolved to bytes, so it is not a
use. A fleet's **logo** is its Oxy organization avatar, which Oxy itself uses.

The columns per type are spelled exactly once, in the SQL function
`moovo_entity_file_ids(entity_type, row)` (migration `0011`). The triggers,
the sync worker, the reconciliation inventory and the takedown handler all go
through it; `file-references.realdb.test.ts` holds it equal to the takedown
handler's `ENTITY_FILE_SLOTS`.

## A file id is accepted only from its owner

`services/files/file-ownership.ts`. Every write path that takes a file id
(listings, stores, fleets, shipments, proof of delivery) takes a
`FileAuthority` and calls `assertFilesAttachable` before writing: each NEWLY
attached id must be an active Oxy **image** owned by the caller (the session's
subject, or the operator of an operated session) or by an account the route
already authorized them to act for (a fleet's organization). Ids the row
already holds are not re-checked. Missing, not-an-image and somebody-else's
answer identically (400); if Oxy cannot be asked the write is refused (503),
never accepted unverified. Ownership comes from `assets.metadataByIds`, which
discloses `ownerUserId` only to Oxy's own (internal-tier) applications.

`services/media.service.ts` resolves Oxy file ids and nothing else. A URL is
never passed through to a client any more.

## Keeping Oxy told: the outbox

Each file-bearing table has `*_file_references` triggers that, in the writer's
own transaction, enqueue every (entity, file) whose use the write CHANGED into
`file_reference_syncs`. No code path can forget: the database does it.

`services/files/file-references.dispatcher.ts` runs on every API task and
drains the outbox every `OXY_FILE_REFERENCE_SYNC_INTERVAL_MS` (10 s): for each
row it asks the database whether the entity uses the file NOW and calls
`OxyServer.assets.references.add` or `.remove`. Rows carry a `generation` so a
write that lands while Oxy is being told is never lost. A failure backs off
30 s doubling to `OXY_FILE_REFERENCE_SYNC_MAX_BACKOFF_MS` (6 h); an add Oxy
refuses (`not_found`: the file is gone or not referenceable) is logged and
dropped. Removing Moovo's last reference never deletes anything: a person's
file becomes "not in use" for them; an application file is collected by Oxy.

## Nightly reconciliation

The same dispatcher reconciles each entity type once a night at
`OXY_FILE_REFERENCE_RECONCILE_HOUR_UTC` (03:00): it streams Moovo's whole
inventory to `references.reconcile`, and Oxy adds what is missing and removes
what is stale. The first run after deploy is immediate and is how rows written
before migration `0011` enter the model. Schedule and last result per type are
in `file_reference_reconciliations` (`last_result`, `last_error`). A failed
run is retried after `OXY_FILE_REFERENCE_RECONCILE_RETRY_MS` (1 h).

- `OXY_FILE_REFERENCE_RECONCILE_DRY_RUN=true` makes the nightly run report
  only (Oxy's counts are stored, nothing changes).
- By hand: `bun dist/scripts/reconcile-file-references.js --target-database=moovo [--entity-type=listing] [--apply]`
  — a dry run unless `--apply`.
- `OXY_FILE_REFERENCES_ENABLED=false` stops the loops on a task; the triggers
  keep filling the outbox, which drains when it is switched back on.

## Category art

Category art used to be hotlinked third-party URLs in `categories.image_url`.
It is now an Oxy file the Moovo application owns, in `image_file_id`, and the
API serves only that. `image_url` stays as the import's provenance.

```bash
bun dist/scripts/import-category-art.js --target-database=moovo           # preview
bun dist/scripts/import-category-art.js --target-database=moovo --apply   # import
```

The preview lists categories by slug and source host. `--apply` calls
`assets.importAppFiles` (public, with the `category` reference in the same
request, so the file is never unreferenced long enough to be collected) and
sets `image_file_id` only on a category still waiting for that same source.
Non-`https` sources are listed as `invalid` (Oxy fetches https only) and stay
without art until their source is fixed. Re-running is safe: categories with
art are skipped and Oxy answers a repeated URL with the file it already holds.

## File events

`POST /webhooks/oxy/files` (`routes/oxy-files-webhook.ts`), mounted before
`express.json()` with its raw parser scoped to that path. It answers Oxy's
`webhook.challenge` (before any secret exists — the secret is issued after the
challenge), and verifies every event with `verifyFileEventSignature` against
`OXY_FILES_WEBHOOK_SECRET` (and `OXY_FILES_WEBHOOK_SECRET_PREVIOUS` during a
rotation); without a secret events are answered 503 so Oxy retries.

`services/files/file-events.service.ts`, exactly once per event id
(`file_event_receipts`, swept after 60 days):

- `file.blocked`, `file.deleted`: the file is cleared from every row that
  shows it — found through the event's references, the outbox, and (for a file
  Moovo owns) the art tables — and every cleared column is recorded in
  `file_takedown_actions` (kept forever: it is the record of a takedown).
- `file.unblocked`: what the block cleared is put back where it was, unless
  that slot was reused meanwhile (`restore_skipped`). A delete is never undone.
- `file.trashed`, `file.restored`, `file.visibility_changed`: recorded only.
  Trash is the owner's reversible choice; Oxy stops serving the file.

## Setting it up

1. Staff grant the Moovo application `files:read`, `files:references:write`
   and `files:app:write` (the three are staff-only for first-party apps).
2. Register the endpoint: console → Webhooks → File events, or
   `oxy.apps.setFilesWebhook(appId, 'https://api.moovo.now/webhooks/oxy/files')`;
   store the returned secret as `OXY_FILES_WEBHOOK_SECRET` (SSM) and redeploy.
3. Preview, then apply, the category art import.

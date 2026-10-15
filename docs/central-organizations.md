# Organization identity and fleet operations

Oxy is the only authority for a company's identity and ownership. A Moovo courier-company row is a fleet profile linked by `oxyAccountId`; its historical ID and handle remain stable fleet route references. Canonical name/avatar reads are deduplicated into batches of at most 100. Missing/suppressed identities are withheld, and directory outages return an error rather than archived names.

Fleet descriptions, covers/colors, vehicles, service areas, operational membership, job metrics and payout references stay in Moovo. The legacy `company_members.role = owner` means **fleet administrator**, shown as such in Hub. It does not grant any Oxy role, company claim or identity-edit permission. Dispatchers and drivers remain direct user memberships in the fleet domain. Financial records are unchanged.

Registering a fleet requires an active claimed Oxy organization and a live owner/admin membership, resolved by `accounts.get` using the original verified caller bearer. Each request uses a disposable SDK client with caching disabled. Human credentials go only to Oxy; the shared server client's session is never changed. A viewer, removed member, unavailable account graph or invalid session cannot register a fleet. Local name/logo create and update fields are rejected. Hub lists the caller's eligible canonical organizations and exposes company identity as read-only in fleet settings.

## Migration and rollout

The 2026-10-15 read-only production inventory found zero courier companies, company members and service areas. This is evidence for the initial rollout, not a permanent assumption.

1. Deploy canonical Oxy APIs and publish the SDK before this consumer. The consumer needs contracts 4.13.0/core 4.6.0; no local dependency override may ship.
2. Normal deployment runs `0008_central_fleet_identity` in the standard `pre` phase. It archives former company name/logo values, freezes legacy identity writes, and allows the new reference-only writer by dropping the old required name constraint. Old company-registration/identity edits require a short write-maintenance window while the prior image drains.
3. The new image serves from canonical references. Historical rows without mappings are withheld from identity-bearing reads, while their operational records remain intact. The standard deploy workflow waits for service stability before automatically attempting the post phase.
4. `0009_retire_local_company_identity` refuses to run if any fleet remains unmapped or its archive disagrees. For the measured empty inventory it proceeds directly. If rows appeared since inventory, the post phase deliberately fails closed; retain the reference-aware image, inspect and apply the reviewed mapping plan below, then rerun post. No automatic name match, invented placeholder or destructive zero-table assumption is used.
5. Post drops only local name/logo columns and makes the canonical reference required. Archive rows are immutable and remain attached to original company IDs. Fleet members, vehicles, service areas, courier affiliations, jobs, shipments and money history keep their existing foreign references.

The backfill requires a selected database and is dry-run by default. It reads source archives, current mappings and relationship counts; a private `--plan-output` file gives reviewers concrete rows and evidence. File creation is mode 0600 and refuses overwrite.

```sh
bun packages/backend/src/scripts/backfill-company-organizations.ts \
  --target-database=moovo --reviewed-mappings=/secure/fleet-links.json \
  --plan-output=/secure/fleet-plan.json

bun packages/backend/src/scripts/backfill-company-organizations.ts \
  --target-database=moovo --reviewed-mappings=/secure/fleet-links.json \
  --apply --plan-sha256=<reviewed-hash>
```

Mappings are `{ "companyId": "legacy-fleet-id", "accountId": "canonical-oxy-account", "evidenceReference": "reviewed-provenance-record" }`. An authorized staff SDK session (`OXY_ADMIN_ACCESS_TOKEN` in the operation environment) links namespace `moovo`, external ID equal to the historical fleet ID. Oxy enforces staff authority and idempotency. Name/logo evidence is never made a new authoritative record or transferred ownership assertion. Duplicate mappings and conflicting links are refused; a unique canonical reference prevents accidentally assigning two fleets to one account. Resolve any domain consolidation explicitly rather than merging on names.

Remote links occur outside local transactions. Each successful source link checkpoints a null-or-same local update. After partial progress, generate and review a fresh plan; Oxy reuses the same source mapping. Secrets are not printed or included in the plan. Run through the existing live-network ECS one-shot mechanism, not an ad hoc tunnel.

Rollback before post keeps the reference-aware image because legacy identity writes are frozen. After post, roll forward or use a reviewed database restore. Do not recreate an editable company registry from the source archive. Production migrations/imports have not been performed by the implementation checks.

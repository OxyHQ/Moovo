# Moovo

Moovo is Oxy's courier and transport platform: packages, food and moves, fulfilled by Moovo couriers or external providers (DHL, FedEx). It is not a marketplace.

## Commands

```bash
bun install                  # postinstall builds shared-types and contracts
bun run dev                  # all workspaces; also dev:frontend, dev:backend, dev:courier, dev:hub, dev:tracker
bun run build                # shared-types, backend, frontend
bun run lint                 # Biome (lint:fix and format to write)
bun run doctor:oxy           # Oxy dependency gate
bun run i18n:check           # translation gate
bun run test:worker          # asset worker
bun run --filter @moovo/backend test   # vitest; also test:bun
bun run check:api-entrypoints
```

## Map

- `packages/backend`, `packages/frontend`, `packages/courier-app`, `packages/fleet-dashboard`, `packages/tracker-app`, `packages/shared-types`, `packages/contracts`, `packages/sdk`: one Express and Postgres backend, four Expo apps, shared packages.
- `packages/backend/src/db/schema/CONVENTIONS.md`: schema and migration rules.
- `HANDOFF.md`: deferred work. `docs/index.mdx`: documentation index.

## Conventions that differ from defaults

- Inherited marketplace code (buy/sell, shops, cart, checkout) is scaffolding, not the domain; the courier domain is `courier-company`, `courier-profile`, `job`, `job-offer`, `provider`, `quote` and `address`. Why: the repo was forked from Mercaria.
- PostgreSQL is the only store; `DATABASE_URL` is the only store config and `db/postgres.ts` refuses to open without it. Why: a default makes a misconfigured task boot and fail every request. Details: [databases](docs/agent-rules/databases.md).
- Every image is an Oxy file; attach client file ids only through `assertFilesAttachable`. Why: otherwise a client stores somebody else's photo. Rules: [Oxy Files](docs/agent-rules/oxy-files.md).
- First-party never asks people for permissions: this app acts for a person with `actingFor` on what oxy's first-party registry declares (oxy ADR 0066); permissions, scopes and consent are only for third parties.
- Tracker work follows the invariants in [tracker rules](docs/agent-rules/tracker.md). Why: several fail silently (cost multiplication, inert SEO head).
- Reports go through CrowdSource: [moderation rules](docs/agent-rules/crowdsource-moderation.md).
- Open Postgres-port decisions with owners: [open decisions](docs/agent-rules/open-decisions-the-postgres-port-left-with-owners.md).
- Formatting and lint are Biome (`biome.json`); a version is read from `package.json`, never written in docs.

## Boundaries

- Never publish to npm from a laptop. Why: merging a version bump to main publishes it. See [packages](docs/agent-rules/packages.md).
- Ask first before changing anything under `.github/workflows/`, the Dockerfile or `.github/scripts/reviewed-image*`. Why: CODEOWNERS routes them to the owner because they decide what production runs. See [deploy](docs/agent-rules/deploy.md).
- Ask first before making `DATABASE_URL` gate boot. Why: it is a deliberate behaviour change nobody has taken.

## Testing

- Backend change: `bun run --filter @moovo/backend test`, then `bun run lint`.
- Contracts, shared-types or entrypoint change: `bun run check:api-entrypoints`.
- Done means lint, `doctor:oxy` and `i18n:check` pass and the relevant tests are green in CI.

## PR and commit rules

Org-wide git and PR conventions are in [OxyHQ/engineering](https://github.com/OxyHQ/engineering/blob/main/AGENTS.md). Branch from `main`; one concern per PR.

## Secrets

Environment variables come from the deploy environment (ECS task definition, Cloudflare Pages settings) and local `.env` files. Never print, log or commit `DATABASE_URL` or any `*_SECRET`.

## Links

- [Oxy engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md)
- [Lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md)
- [Postgres and Drizzle](https://github.com/OxyHQ/oxy/blob/main/docs/postgres-and-drizzle.md)
- [npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)
- [Bloom app conventions](https://github.com/OxyHQ/Bloom/blob/main/docs/app-conventions.mdx)

Owner: @NateIsern (CODEOWNERS). Last reviewed: 2026-11-11.

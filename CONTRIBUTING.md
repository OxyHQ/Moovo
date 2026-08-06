# Contributing to Moovo

Moovo is Oxy's courier and transport platform: send a package, food, or a whole move, carried by Moovo's own couriers or handed to an external provider.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`, and CI installs that exact version.
- **Node.js 22.** The runtime the API is built and deployed on. CI pins it alongside bun.
- **MongoDB**, local or remote, to run the API. The test suite does not need one; it starts its own, and the first run downloads server binaries.
- **Redis**, optional. Rate limiting and Socket.IO scaling fall back gracefully without it.

## Setup

```bash
git clone https://github.com/OxyHQ/Moovo.git && cd Moovo
bun install
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev                                              # every package at once
```

## The root script names do not match the package names

This is the one thing in the repository you cannot guess from the tree, so it is worth reading before you run anything:

| Script | Package | Ships as |
| --- | --- | --- |
| `bun run dev:backend` | `@moovo/backend` | The API |
| `bun run dev:frontend` | `@moovo/frontend` | The customer app (runs with `--clear --tunnel`) |
| `bun run dev:courier` | `@moovo/courier-app` | Moovo Go, the courier app |
| `bun run dev:hub` | `@moovo/fleet-dashboard` | Moovo Hub, the fleet and ops dashboard |

`build:*` follows the same naming. There is no `dev:api` and no `dev:app`.

`packages/frontend`, `packages/courier-app` and `packages/fleet-dashboard` each ship their own `.env.example`; copy the ones for the apps you are running.

## Layout

A bun workspaces monorepo, five packages:

| Package | Path | Role |
| --- | --- | --- |
| `@moovo/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@moovo/frontend` | `packages/frontend/` | Expo customer app |
| `@moovo/courier-app` | `packages/courier-app/` | Expo courier app (Moovo Go) |
| `@moovo/fleet-dashboard` | `packages/fleet-dashboard/` | Fleet and ops dashboard (Moovo Hub) |
| `@moovo/shared-types` | `packages/shared-types/` | Domain DTOs |

`shared-types` is built by `postinstall` and again ahead of the backend build. Run `bun run build:shared-types` after changing a shared type.

**Moovo was forked from the Mercaria marketplace shell, and the inherited marketplace code is still on disk** (cart, listing, order, product variant and category models, plus buy and sell, shops, search and checkout surfaces). It is scaffolding on its way out, not the domain. The live courier domain is `courier-company`, `courier-profile`, `job`, `job-offer`, `provider`, `quote` and `address`. Do not build on the marketplace side, and do not assume a marketplace shape is the intended one. `HANDOFF.md` lists the deferred work.

## Tests

```bash
bun run --filter @moovo/backend test
```

Vitest. Place test files next to the source as `*.test.ts`. `packages/backend` is the only package with a suite today.

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun run --filter @moovo/backend lint
bun run --filter @moovo/backend typecheck
bun run --filter @moovo/backend test
bun run build:backend
bun run build:frontend
```

Note that CI builds only `packages/frontend`. A change touching the shared frontend stack can break Moovo Go or Moovo Hub without CI noticing, so build those locally (`bun run build:courier`, `bun run build:hub`) when you touch anything they share.

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root. If you are going anywhere near `packages/backend/src/services/moderation/`, read it first: the redaction rules that keep a customer's address and a courier's phone number out of a stranger's jury view are load bearing, and several of the invariants there fail silently rather than loudly. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.

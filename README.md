# Moovo

A courier/transport platform by [Oxy](https://oxy.so) — send packages, food, and moves (mudanzas), fulfilled by Moovo's own couriers (Glovo-style) or external providers (DHL, FedEx).

This repository is the proven Oxy Expo + Express monorepo with Oxy auth/SSO, Socket.IO, TanStack Query, NativeWind, and deploy CI wired up. It was forked from the Mercaria marketplace base shell; the inherited marketplace domain code (listings, buy/sell, shops, cart, checkout, orders) is still present and will be removed/replaced by the Moovo courier/transport domain in a later phase.

> See [`HANDOFF.md`](./HANDOFF.md) for what is intentionally deferred (infra, Oxy RP client registration, the Moovo courier/transport domain).

## Stack

- **Frontend**: Expo (SDK 56) + React Native Web + NativeWind 5 (Tailwind v4) + Reanimated + Zustand + TanStack Query
- **Backend**: Express + TypeScript + MongoDB/Mongoose + Redis (optional) + Socket.IO
- **Auth**: Oxy (`@oxyhq/core`, `@oxyhq/services`) — device-first session handled entirely by the SDK
- **UI**: `@oxyhq/bloom` shared component library
- **Infra**: AWS ECS Fargate (API) + Cloudflare Pages (web) — see `HANDOFF.md`

## Monorepo

```
packages/
  frontend/      # Expo cross-platform app (web + iOS + Android)
  backend/       # Express backend API
  shared-types/  # TypeScript DTOs shared by frontend + backend
```

This is a **bun workspaces** monorepo. Use `bun` (never npm/yarn) and `bunx` (never npx).

## Development

```bash
bun install
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev:backend    # start the API (Express) on :3001
bun run dev:frontend   # start the app (Expo)
```

## Build & verify

```bash
bun run build:backend  # esbuild bundle -> packages/backend/dist/index.js
bun run build:frontend  # Expo web export -> packages/frontend/dist
```

Type-check:

```bash
cd packages/backend && bunx tsc --noEmit
cd packages/frontend && bunx tsc --noEmit
```

## Tests

```bash
bun run --filter @moovo/backend test   # Vitest
```

## Conventions

- TypeScript-first. No `as any`, no `@ts-ignore`, no non-null `!` assertions.
- Frontend styling via NativeWind classNames (not inline styles where a class exists).
- State via Zustand; data fetching via TanStack Query; routing via expo-router.
- Backend auth uses `@oxyhq/core/server` middleware — do not hand-roll auth.
- MongoDB database name follows `moovo-{NODE_ENV}` (passed to `mongoose.connect()`).

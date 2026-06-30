# Moovo — Courier/Transport Platform

Moovo is a courier/transport platform by Oxy — send packages, food, and moves (mudanzas); fulfilled by Moovo's own couriers (Glovo-style) or external providers (DHL, FedEx).

This repo was forked from the Mercaria marketplace base shell. The inherited marketplace domain code (listings, buy/sell, shops, search, cart, checkout, orders) is still present and will be removed/replaced by the Moovo courier/transport domain. Treat it as legacy scaffolding, not the target domain.

See `HANDOFF.md` for deferred work (infra, Oxy client registration, the Moovo courier/transport domain).

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@moovo/frontend` | `packages/frontend/` | Expo customer-facing app |
| `@moovo/courier-app` | `packages/courier-app/` | Expo app for couriers |
| `@moovo/fleet-dashboard` | `packages/fleet-dashboard/` | Fleet/ops management dashboard |
| `@moovo/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@moovo/shared-types` | `packages/shared-types/` | TypeScript domain DTOs |

`@moovo/shared-types` currently holds inherited marketplace DTOs (`Listing`, `Money`, etc.); these will be replaced by courier/transport DTOs (deliveries, shipments, couriers, providers). Build: `bun run build:shared-types`.

## Tech Stack

- **Frontend / Courier App / Dashboard**: Expo SDK 56, NativeWind 5 (Tailwind v4 + postcss), Reanimated, Zustand, TanStack Query, expo-router
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Redis (optional), Socket.IO
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services`, `@oxyhq/auth` (web SSO RP)
- **UI**: `@oxyhq/bloom`
- **Client ID**: `EXPO_PUBLIC_OXY_CLIENT_ID`; backend auth: `packages/backend/src/middleware/auth.ts`

## MongoDB

Database: `moovo-production` (passed to `mongoose.connect()` via `dbName`, NOT embedded in `MONGODB_URI`). See `packages/backend/src/lib/db.ts`.

## Deploy

- **API** → AWS ECS Fargate, `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR `oxy/moovo`). ECS service + task def + ALB rule + ECR repo + SSM params must be provisioned in `oxy-infra` first (handoff).
- **Web** → Cloudflare Pages, `.github/workflows/deploy-cloudflare.yml`. CF Pages project + DNS must be created first (handoff).
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on every push/PR.

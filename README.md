<p align="center">
  <b>Moovo</b> is a courier and transport platform by <a href="https://oxy.so">Oxy</a>.<br>
  Send a package, food, or a whole move, carried by Moovo's own couriers or handed to an external provider.
</p>

<p align="center">
  <img alt="Expo SDK 56" src="https://img.shields.io/badge/Expo-SDK%2056-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.85" src="https://img.shields.io/badge/React%20Native-0.85-440151?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.3-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-440151?style=flat-square&logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Drizzle-440151?style=flat-square&logo=postgresql&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 🚚 Three sides of one delivery

A job is created by a sender, offered to couriers, accepted, picked up, and dropped off. Each side gets its own Expo app: the customer app that books it, Moovo Go that the courier carries, and Moovo Hub where a fleet dispatches and watches it.

One Express API owns the job, the offers, the quote and the shipment, so the three apps never disagree about the state of a delivery.

</td>
<td valign="top" width="50%">

### 🔑 Identity comes from Oxy

There is no Moovo account. Sign in is the device first Oxy session, handled end to end by [`@oxyhq/services`](https://www.npmjs.com/package/@oxyhq/services) on the client and [`@oxyhq/core`](https://www.npmjs.com/package/@oxyhq/core) on the server.

No local token providers, no auth interceptors, no hand rolled bearer parsing. See the [Oxy platform repo](https://github.com/OxyHQ/oxy) for how the session itself works.

</td>
</tr>
</table>

## Packages

| Package | Path | What it is |
|---|---|---|
| `@moovo/frontend` | [`packages/frontend/`](packages/frontend/) | Moovo, the customer app: book a send, track jobs, shipments, orders |
| `@moovo/courier-app` | [`packages/courier-app/`](packages/courier-app/) | Moovo Go, the courier app: job offers, vehicles, pickup and dropoff |
| `@moovo/fleet-dashboard` | [`packages/fleet-dashboard/`](packages/fleet-dashboard/) | Moovo Hub, the fleet console: dispatch, fleet, companies, members, stats |
| `@moovo/backend` | [`packages/backend/`](packages/backend/) | Express API: TypeScript, PostgreSQL via drizzle-orm, Socket.IO |
| `@moovo/shared-types` | [`packages/shared-types/`](packages/shared-types/) | Domain DTOs every package imports |

All three apps are Expo, render [`@oxyhq/bloom`](https://www.npmjs.com/package/@oxyhq/bloom) primitives with NativeWind, and draw maps with `react-native-maps`.

> Moovo was forked from the Mercaria marketplace shell, and the inherited marketplace code (listings, cart, checkout, stores, reviews) is still in the tree. Treat it as scaffolding on its way out, not as the Moovo domain.

## Quick start

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
bun run dev:backend
bun run dev:frontend
```

Bun 1.3.14. Use `bun` and `bunx`, never npm, yarn or npx.

<details>
<summary><b>All the commands</b></summary>

<br>

```bash
bun run dev              # every workspace at once
bun run dev:frontend     # customer app
bun run dev:courier      # Moovo Go
bun run dev:hub          # Moovo Hub
bun run dev:backend      # API

bun run build            # shared-types, then backend, then frontend
bun run build:courier    # Expo web export for Moovo Go
bun run build:hub        # Expo web export for Moovo Hub
bun run lint             # every workspace

bun run --filter @moovo/backend test        # Vitest
bun run --filter @moovo/backend typecheck   # tsc --noEmit
```

`bun run android`, `bun run ios` and `bun run web` target the customer app.

</details>

<details>
<summary><b>The courier domain</b></summary>

<br>

| Model | What it holds |
|---|---|
| `Job` | One movement: pickup, dropoff, timing, proof of delivery, verification codes |
| `JobOffer` | A job put in front of a courier, accepted or declined |
| `CourierProfile` | A person who carries jobs, and their status |
| `CourierCompany` | A fleet, its members and the jobs it dispatches |
| `Vehicle` | What a courier carries jobs with |
| `Quote` | A price for a job before it is booked |
| `Shipment` | A movement fulfilled by an external provider |
| `Provider` | An external carrier a shipment can be handed to |

Routes live under [`packages/backend/src/routes/`](packages/backend/src/routes/): `jobs`, `courier`, `shipments` are the live courier surface.

</details>

<details>
<summary><b>Abuse reports go to CrowdSource, and a delivery is not a listing</b></summary>

<br>

Moovo does not run a moderation panel. Reports are committed locally with a durable outbox row in the same transaction, then delivered to [CrowdSource](https://github.com/OxyHQ/CrowdSource), which decides them with a randomly drawn jury and returns signed decisions over a webhook.

What a jury sees is deliberately narrow. A job carries two names, two phone numbers, two street addresses, two precise coordinate pairs and the pickup and dropoff verification codes, and none of that leaves Moovo. Geography travels as a single rounded `distanceKm`, which answers whether a courier took a detour and identifies nobody, because a distance is translation invariant. The set of fields a delivery may emit is pinned by a test as an exact set, so a field nobody thought to forbid still fails the build.

Moovo has one enforcement lever, the courier's status, applied to courier privileges and never to the Oxy account. There is deliberately no way to cancel a delivery in flight, because that strands a courier holding someone else's property.

Built on [`@oxyhq/crowdsource`](https://www.npmjs.com/package/@oxyhq/crowdsource) and [`@oxyhq/crowdsource-express`](https://www.npmjs.com/package/@oxyhq/crowdsource-express).

</details>

<details>
<summary><b>Deploy</b></summary>

<br>

Everything ships from GitHub Actions in [`.github/workflows/`](.github/workflows/):

| Workflow | Target |
|---|---|
| `ci.yml` | Lint, tests, API build and app builds on every push and pull request |
| `deploy-aws.yml` | API to AWS ECS Fargate on `linux/arm64` |
| `deploy-cloudflare.yml` | Customer app web build to Cloudflare Pages |
| `deploy-cloudflare-go.yml` | Moovo Go web build |
| `deploy-cloudflare-hub.yml` | Moovo Hub web build |

</details>

## Conventions

TypeScript first, with no `as any`, no `@ts-ignore` and no non null assertions. Styling is NativeWind classes rather than inline styles. State is Zustand, data fetching is TanStack Query, routing is expo-router. Backend auth is `@oxyhq/core/server` middleware and is never hand rolled.

Longer form docs live in [`docs/`](docs/), the full working agreement in [`AGENTS.md`](AGENTS.md), and setup details in [`CONTRIBUTING.md`](CONTRIBUTING.md).

<br>

<div align="center">
<sub>Part of the <a href="https://github.com/OxyHQ">Oxy</a> ecosystem</sub>
</div>

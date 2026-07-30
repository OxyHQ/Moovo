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
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services` (device-first web + native)
- **UI**: `@oxyhq/bloom`
- **Client ID**: `EXPO_PUBLIC_OXY_CLIENT_ID`; backend auth: `packages/backend/src/middleware/auth.ts`

## MongoDB

Database: `moovo-production` (passed to `mongoose.connect()` via `dbName`, NOT embedded in `MONGODB_URI`). See `packages/backend/src/lib/db.ts`.

## CrowdSource Moderation

Reports leave Moovo durably, CrowdSource decides them with a randomly drawn jury, and decisions come back signed. **CrowdSource owns cases, reviews and decisions; Oxy Trust owns reputation; Moovo owns only its own enforcement actions.** Everything lives in `packages/backend/src/services/moderation/`, four models (`report`, `moderation-outbox`, `moderation-event`, `moderation-enforcement`) and two routes.

**What is reportable.** The LIVE courier domain is delivered: `courier` and `customer` (both `identity.profile`) and `delivery` (`custom.moovo.delivery`). The inherited marketplace nouns (`listing`, `store`, `review`) are accepted by `POST /reports` and stored, but have **no subject provider**, so they never leave — they are Mercaria scaffolding being removed, and wiring a provider to a model scheduled for deletion buys nothing. The registry decides DELIVERY, never admission: gating the route on it would break existing report surfaces on adoption day.

**A delivery is not a `commerce.listing`.** A listing is an offer published to anyone who looks; a delivery is a private movement of an object between two named people. Forcing it into the commerce vocabulary tells a jury the wrong thing about what it is reading. Allegation codes are mapped honestly the same way: `commerce.prohibited_item` genuinely fits, while "the courier drove dangerously" has no universal code and becomes `other.policy_specific` rather than being bent into `integrity.*`.

**`subjects/redaction.ts` is the load-bearing file — read it before touching a subject provider.** A `Job` carries two contact names, two phone numbers, two street addresses, two precise coordinate pairs, `proofOfDelivery.recipientName`, `payment.reference` and the pickup/dropoff verification codes. None of it reaches a jury; the codes are a CREDENTIAL, not evidence. Coordinates are **dropped, not coarsened** — the contract would accept two decimals, but two 1.1 km squares plus a timestamp narrow a household further than either alone, and a city label answers every jurisdiction question a jury has. Tests search the whole serialised output for sentinel values rather than asserting a field whitelist, so a newly-added leaking field fails them.

**A conduct report names an account but is about an ENCOUNTER.** `contextJobId` on a report attaches the delivery as context so a jury can answer "was this courier abusive" — which a profile alone cannot support. `ReportIntakeService` verifies server-side that the reporter was the sender or the assigned courier on that job; without that check any user could attach any job id and have Moovo package a stranger's delivery into a case. It fails silently (context dropped, report still stored) so a prober cannot learn which job ids exist.

**Moovo has exactly ONE enforcement lever**, `CourierProfile.status` — this integration is its first writer. There is deliberately no `restrict_delivery`: a collected parcel cannot be un-collected, and cancelling a job mid-transit strands a courier holding somebody's property, so a decision about a delivery becomes `manual_review`. There is no customer-side lever at all. `suspend_user` is carried out as `suspend_courier` (privileges only, never the Oxy account) and recorded under that narrower name. `no_violation` ALWAYS plans a `reinstate_courier` even when the recommendation is `no_action` — otherwise a successful appeal leaves a courier suspended forever, with no error anywhere.

**Two invariants that fail silently if broken:**
- `enqueueModerationOutboxEvent` **throws unless `session.inTransaction()`**. The report and its delivery event commit together or not at all; a bare `startSession()` type-checks, commits the row alone, and passes any test that only asserts the row exists.
- The webhook router **must stay mounted before `express.json()`** in `index.ts`. The signature covers the bytes that arrived. Guarded by a test asserting `typeof req.body === 'undefined'` inside the route, plus one that pins the ordering in `index.ts` itself.

**Env:** `CROWDSOURCE_ENABLED` (requires BOTH the service key and webhook secret to take effect), `CROWDSOURCE_SERVICE_KEY`, `CROWDSOURCE_BASE_URL`, `CROWDSOURCE_WEBHOOK_SECRET`, `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`, `CROWDSOURCE_OUTBOX_BATCH_SIZE`, `CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS`, `CROWDSOURCE_ENFORCEMENT_MODE` (default `observe`). **There is no `CROWDSOURCE_APP_ID`, and never add one** — `applicationId` is read off the credential, and a surface able to carry one is the cross-tenant write the tenancy model exists to prevent.

## Deploy

- **API** → AWS ECS Fargate, `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR `oxy/moovo`). ECS service + task def + ALB rule + ECR repo + SSM params must be provisioned in `oxy-infra` first (handoff).
- **Web** → Cloudflare Pages, `.github/workflows/deploy-cloudflare.yml`. CF Pages project + DNS must be created first (handoff).
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on every push/PR.

# Moovo — Handoff

Moovo is a courier/transport platform by [Oxy](https://oxy.so) — send packages,
food, and moves (mudanzas), fulfilled by Moovo's own couriers (Glovo-style) or
external providers (DHL, FedEx).

This repo was forked from the **Mercaria** marketplace base shell and mechanically
rebranded to **Moovo**. The following work is intentionally deferred.

## 1. Domain decisions (already applied to config)

| Setting | Value |
| --- | --- |
| Web | `moovo.now` |
| API | `api.moovo.now` |
| Staging API | `staging-api.moovo.now` |
| App scheme | `moovo` |
| iOS bundle id / Android package | `now.moovo.app` |
| MongoDB db name | `moovo-{NODE_ENV}` |
| AWS ECR repo | `oxy/moovo` (cluster stays `oxy-cluster`) |
| Cloudflare Pages project | `moovo` |

## 2. Oxy RP client registration (BLOCKING for SSO)

`packages/frontend/lib/config.ts` ships a **temporary placeholder** `oxy_dk_…`
client id inherited from Mercaria — it is NOT a registered Moovo RP client. A
dedicated Moovo Oxy RP application must be registered, and its public client id
wired into `OXY_CLIENT_ID` (and the `EXPO_PUBLIC_OXY_CLIENT_ID` build var /
Cloudflare Pages project variable) before the SSO RP flow works for Moovo.

## 3. Infrastructure (oxy-infra `terraform-uswest2/`)

The deploy workflows build + push images but the AWS resources do not exist yet:

- ECS service `moovo`, its task definition, ALB listener rule, ECR repo
  (`oxy/moovo`), and SSM parameter wiring (`/oxy/moovo/*`) must be provisioned in
  `oxy-infra`. Until then `.github/workflows/deploy-aws.yml` pushes the image to
  ECR and skips the ECS step (service-existence guard).
- The Cloudflare Pages project `moovo` and its DNS (`moovo.now`, `api.moovo.now`,
  `staging-api.moovo.now`) must be created before
  `.github/workflows/deploy-cloudflare.yml` can deploy the web app.

## 4. Courier/transport domain (replaces the inherited marketplace domain)

This repo still carries the inherited **marketplace** domain code (listings,
buy/sell, shops, search, cart, checkout, orders) in `packages/backend/src` and
`packages/frontend`, plus the marketplace DTOs in `packages/shared-types`. This
is legacy scaffolding from the Mercaria base, NOT the Moovo target domain. In a
later phase it will be removed/replaced by the Moovo courier/transport domain
(deliveries, shipments, couriers, providers, fulfillment routing between
Moovo's own couriers and external providers like DHL/FedEx).

**This is the last thing holding the Mongo connection open.** Every courier
domain is on PostgreSQL as of #57; `lib/db.ts` and `MONGODB_URI` survive only
because 26 files (22 of them non-test) still import one of 8 inherited
marketplace models — cart, category, listing, order, product-variant, review,
seller-profile, store.

**DECIDED 2026-08-10: the marketplace is PORTED to PostgreSQL, not deleted.**
The product owner chose it knowing the measurement below; it is not an
engineering judgement and it should not be relitigated from the code.

### What the port starts from, measured rather than assumed

- **No schema work.** All 13 marketplace tables already ship in migration
  `0000` — `carts`, `cart_items`, `categories`, `listings`, `product_variants`,
  `inventory_levels`, `orders`, `order_items`, `order_status_events`,
  `reviews`, `seller_profiles`, `stores`, `store_members`. This is
  repositories and rewiring only.
- **8 registered Mongoose models, not 10.** `models/schemas/{money,fair-money}-schema.ts`
  register nothing; they are embedded sub-schemas. All 8 are marketplace, so
  zero courier models remain.
- **The blast radius is 45 files / 5,795 lines, not 26 files.** A model-importer
  census structurally cannot see this, because controllers import SERVICES, not
  models. The number comes from reachability out of `src/index.ts` with the
  marketplace routers blocked (172 reachable → 127).
- **No frontend calls any of it.** The only marketplace endpoint referenced in
  the three Expo apps is `/listings`, in a `lib/api/listings.ts` that has zero
  importers. Two separate findings follow and are NOT part of the port: 36 dead
  frontend files / 3,159 lines, and 9 shared-types DTO files whose only
  consumers are those dead trees. The port may give the DTOs real consumers,
  which is why it is a live question rather than a deletion.

### The transaction prediction in this file was WRONG — do not inherit it

An earlier revision predicted that `checkout`/`cart`/`order` share transactions
the way the moderation outbox coupled its models. **Measured: there is not one
`startSession`, `withTransaction`, `.session(` or `ClientSession` anywhere in
`packages/backend/src`.** The single grep hit is the word "session" in a
comment. The service graph is also a clean DAG. So the work genuinely slices by
domain, and the constraint that forced moderation's three models to move as a
unit has no analogue here. That prediction was reasonable when written; it is
recorded as wrong because a handover prediction exists to be checked.

Slices, ordered so each is useful rather than by table count: `resolveMedia`
(landed, #60) → stores + seller profiles → catalogue (the first point at which
Moovo can serve a listing) → cart → orders + checkout → reviews. Note
`queue/handlers.ts` does not belong to one slice: `handleLowInventoryAlert` is
the catalogue's, `handleOrderEventNotification` and `handleExpireReservations`
are orders', `handleRecomputeAggregates` and `handleAggregateSweep` are
reviews'.

Because the target is empty, a repository returning nothing and a repository
correctly returning nothing are the same observation. Every slice therefore
lands with a fixture seeding **two owners** and asserting the wrong owner's rows
are absent — that is what distinguishes a working filter from an absent one.

### Verify against the entrypoint production actually runs, not the convenient one

Measured 2026-08-10 while proving the boot gate (#59). Booting the API with
`bun src/index.ts` dies in `bson` with `ERR_NOT_IMPLEMENTED` — a Bun/mongoose
incompatibility — so the process **exits 1 with nothing listening**, which is
indistinguishable from the Mongo-connection failure being investigated while
measuring something else entirely. The right conclusion was one step from being
reported on evidence that did not support it.

`package.json`'s `start` is `node dist/index.js`, and that is the only runtime
worth booting for a start-up question: `bun run build`, then run the built
artefact. The same applies to any future claim about what happens at boot — the
convenient entrypoint and the real one fail differently.

### A Postgres write can hide inside a block you are gating on Mongo

The same fix had to gate `connectDB()` without gating the block that followed
it. That block contains `seedProviders()`, which writes through
`db/transport/providerRepository` to **PostgreSQL**. Gating the whole thing
behind a Mongo connection would have silently stopped external carrier quotes
surfacing — a **courier regression hiding inside a Mongo fix**, in the half of
the product that was already migrated and working.

Nobody reading a diff titled "boot without Mongo" is looking for a Postgres
write inside the block being gated, which is exactly why it survives review.
Before gating any start-up block, enumerate what it actually does; the
dispatchers, the socket server and the provider seed all live in that one
`.then()` and none of them needs Mongo.

### Two things whoever does that work needs, which are cheap to lose

**A closed booking window was never actually hit, and that retires the repair
rather than the bug.** `port/jobs-dispatch` closed a booking window; Moovo has
zero shipments in production, so nobody had reached it. Nobody hit it because
nothing has run through that path yet, not because the path was safe. Anything
that reasons "this has never gone wrong in production" about a pre-launch
service is reasoning from an empty sample.

**Map the TRANSACTION boundaries before proposing how to split the work — not
the import graph.** Importer counts look like they identify separable units and
they do not, and the error is in the direction that looks tidy. Measured during
the moderation port: the four models had 1 / 1 / 2 / 4 importers, which reads as
four independent sub-units, but the outbox transaction couples `reports` +
`moderation_outboxes` (intake) and `moderation_events` + `moderation_outboxes`
(inbound) — and a Mongo `ClientSession` cannot enlist a Postgres write. So no
ordering avoided an intermediate state that destroyed exactly the atomicity the
outbox exists for; three models had to move together and only enforcement (~4%
of the change) was genuinely free-standing. The marketplace models share
`checkout`/`cart`/`order` transactions in the same way, so expect the same
answer there: the seam is where the transactions are, and finding it needs a
measurement rather than a census.

## 5. Branding assets

Icons and splash images under `packages/frontend/assets/` and
`packages/frontend/public/` are still the Mercaria-era binaries. They are left
as-is for a branding handoff — regenerate them with Moovo branding.

## 6. Maps / native module dependencies (added for the courier UX)

The three frontends now depend on map, location, and camera modules for the
courier/transport UX:

- `maplibre-gl` (5.24.0) — web map renderer, all three apps. Uses OpenStreetMap
  tiles by default; **no API key required** for web. (No `@types/maplibre-gl` —
  maplibre-gl ships its own bundled types; the `@types` stub is deprecated.)
- `react-native-maps` (1.27.2) — native map, all three apps.
- `expo-location` (~56.0.18) — GPS. `packages/frontend` (customer, when-in-use)
  and `packages/courier-app` (Moovo Go, when-in-use + background for live
  position pings). Config plugins + permission strings added to each `app.json`.
- `expo-camera` (~56.0.8) — `packages/courier-app` only, for scanning
  pickup/delivery QR codes. Config plugin + permission string added.

**Platform split required (UI work, not done here):** the web bundle must NEVER
import `react-native-maps`. The map component must be platform-split
(`Map.web.tsx` → maplibre-gl, `Map.native.tsx` → react-native-maps).

**Android native Maps key — DEFERRED:** `react-native-maps` on **Android**
requires a Google Maps API key (`expo.android.config.googleMaps.apiKey` in
`app.json`, sourced from a secret — do NOT hardcode). None is provisioned yet.
- **Web** uses maplibre-gl / OSM → no key.
- **iOS** native uses Apple Maps → no key.
- **Android** native builds will show a blank map until a Google Maps key is
  added. Provision the key and wire it before the first Android native build.

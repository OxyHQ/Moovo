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
seller-profile, store. Whether that code is PORTED or DELETED is a product
decision, not an engineering one, and it is the only open question left.

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

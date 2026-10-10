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
| AWS ECR repo | `oxy/moovo` (cluster stays `oxy-cluster`) |
| Cloudflare Pages projects | `moovo`, `moovo-go`, `moovo-hub`, `moovo-tracker` |
| Tracker web | `tracker.moovo.now` (scheme `moovotracker`, bundle `now.moovo.tracker`) |

## 2. Oxy RP client registration (BLOCKING for SSO)

`packages/frontend/lib/config.ts` ships a **temporary placeholder** `oxy_dk_…`
client id inherited from Mercaria — it is NOT a registered Moovo RP client. A
dedicated Moovo Oxy RP application must be registered, and its public client id
wired into `OXY_CLIENT_ID` (and the `EXPO_PUBLIC_OXY_CLIENT_ID` build var /
Cloudflare Pages project variable) before the SSO RP flow works for Moovo.

## 3. Infrastructure (oxy-infra `terraform-uswest2/`)

- **DONE — ECS.** The service `moovo` on `oxy-cluster`, its task definition, ALB
  listener rule, ECR repo (`oxy/moovo`) and SSM wiring are provisioned and
  serving; `deploy-aws.yml` deploys onto them and its service-existence guard is
  a guard, not the normal path. A run reporting "not created yet" means the
  infrastructure moved.
- **DONE — Pages `moovo`, `moovo-go`, `moovo-hub`.** Created, with DNS. All three
  deployed successfully on 2026-08-26.
- **DONE — Pages `moovo-tracker` and `tracker.moovo.now`.** Created 2026-09-07 on
  account `fa4392797e57d4e63ceaaf7b1dc687ed`, production branch `main`,
  compatibility date `2026-06-22` (matching `moovo-go`). DNS is
  `CNAME tracker -> moovo-tracker.pages.dev`, proxied, in zone `moovo.now`
  (`501d6f875f73e0bcf72a34adaa5951b4`) — the same shape as `go` and `hub`. The
  custom domain is active and the site serves.
- **DONE — `CLOUDFLARE_API_TOKEN` rotated 2026-09-07.** The previous secret (set
  2026-07-15, last successful deploy 2026-08-26) had stopped authenticating:
  every Pages deploy failed with `Authentication error [code: 10000]`. Replaced
  with the account token in `~/.config/oxy/tokens/cloudflare.token`, and
  `CLOUDFLARE_ACCOUNT_ID` re-set to the value above. All four Pages workflows
  deploy again — verified by re-running the three that had failed.

  **The repo secret and that file are now the same credential, so they expire
  together.** When Pages deploys start failing with `10000`, check whether the
  local token still verifies (`GET /user/tokens/verify`) before assuming the
  secret drifted: if the token itself was revoked, rotating the secret from that
  file copies the dead credential back in.
- **TODO — FedEx Track API credentials, and the one live call that confirms the
  mapping.** `services/tracking/adapters/fedex.ts` is written and unit-tested,
  but its fixtures are built from FedEx's published shape, so they pin THIS
  CODE'S READING of that shape and cannot prove FedEx sends those field names.
  The request flow and the response FIELD NAMES have since been corroborated
  against a real recorded FedEx response published by PackageMate (MIT), so the
  envelope, `derivedCode`, the offsets on scan dates, `ESTIMATED_DELIVERY`,
  `serviceDetail.description` and `shipperInformation.address.countryCode` match
  a live payload — and scan events really do arrive newest-first, which is why
  the adapter sorts. **The ERROR shape remains unconfirmed**, because a recorded
  success cannot show one; not-found is therefore matched on a pattern and every
  other error is thrown into backoff, which is the safe direction.

  To finish it: register at developer.fedex.com, set `FEDEX_CLIENT_ID` and
  `FEDEX_CLIENT_SECRET` (both, or the carrier stays deep-link-only), point
  `FEDEX_BASE_URL` at the sandbox first, track one real number AND one
  deliberately invalid one — the invalid one is the whole point, since it is the
  only way to see the error code. Only then set
  `TRACKING_ENABLED=true` and `UPDATE tracking_carriers SET poll_supported = true
  WHERE key = 'fedex'` — seeding is `ON CONFLICT DO NOTHING` and will never do it
  for you, which is the point: nothing starts polling because a deploy happened.

  Every other carrier in the catalogue is deep-link-only and needs no
  credentials. `source_kind = 'public_page'` remains a LEGAL decision per
  carrier, owned by legal, and no carrier is enabled in that mode without
  approval.

- **KNOWN — the Pages workflows can rate-limit each other.** A push touching
  `package.json` or `bun.lock` matches every Pages workflow's path filter, so
  they all fire at once against one account. On 2026-09-06 that returned
  `Rate limited [code: 10429]` on all three. The tracker merge on 2026-09-07
  fired all FOUR simultaneously and every one succeeded, so the limit is not hit
  every time — which is exactly why this is still open rather than fixed: it
  fails intermittently, and a green run is not evidence it went away.
  Serialising them (a shared `concurrency` group, or a retry with backoff on the
  wrangler step) is the fix when it next bites.

## 4. Courier/transport domain (replaces the inherited marketplace domain)

This repo still carries the inherited **marketplace** domain code (listings,
buy/sell, shops, search, cart, checkout, orders) in `packages/backend/src` and
`packages/frontend`, plus the marketplace DTOs in `packages/shared-types`. This
is legacy scaffolding from the Mercaria base, NOT the Moovo target domain. In a
later phase it will be removed/replaced by the Moovo courier/transport domain
(deliveries, shipments, couriers, providers, fulfillment routing between
Moovo's own couriers and external providers like DHL/FedEx).

**DECIDED 2026-08-10: the marketplace runs on PostgreSQL, not deleted.** The
product owner chose it; it is not an engineering judgement and it should not be
relitigated from the code. **No frontend calls any of it.** The only
marketplace endpoint referenced in the three Expo apps is `/listings`, in a
`lib/api/listings.ts` that has zero importers. Two separate findings follow:
36 dead frontend files / 3,159 lines, and 9 shared-types DTO files whose only
consumers are those dead trees.

### Verify against the entrypoint production actually runs, not the convenient one

`package.json`'s `start` is `node dist/index.js`, and that is the only runtime
worth booting for a start-up question: `bun run build`, then run the built
artefact — the runtime image is `node`, and bun shims globals node does not
(`__dirname` in an ESM bundle is the standing example). A process that exits 1
under `bun src/index.ts` with nothing listening is indistinguishable from the
failure you are investigating. A start-up change is verified by running the
BUILT `dist/index.js` under `node`, reaching `API Server running`, a 200 from
`/health/ready`, and a complete graceful shutdown on SIGTERM.

### A Postgres write can hide inside a start-up block you are gating

Start-up runs `seedProviders()`, which writes through
`db/transport/providerRepository` to PostgreSQL. Wrapping a condition around a
start-up block that contains it would silently stop external carrier quotes
surfacing, and nobody reading a diff titled after the condition is looking for
a write inside the block. The dispatchers, the socket server and the provider
seed run as ordinary top-level start-up inside one `try`. **Before gating any
start-up block, enumerate what it actually does.**

### Two things whoever does that work needs, which are cheap to lose

**A closed booking window was never actually hit, and that retires the repair
rather than the bug.** `port/jobs-dispatch` closed a booking window; Moovo has
zero shipments in production, so nobody had reached it. Nobody hit it because
nothing has run through that path yet, not because the path was safe. Anything
that reasons "this has never gone wrong in production" about a pre-launch
service is reasoning from an empty sample.

**Map the TRANSACTION boundaries before proposing how to split the work — not
the import graph.** Importer counts look like they identify separable units and
they do not, and the error is in the direction that looks tidy. In moderation
the four tables have 1 / 1 / 2 / 4 importers, which reads as four independent
sub-units, but the outbox transaction couples `reports` +
`moderation_outboxes` (intake) and `moderation_events` + `moderation_outboxes`
(inbound), so three of them move together and only enforcement is genuinely
free-standing. The marketplace is the opposite case: there is not one shared
transaction between `checkout`, `cart` and `order`, so work there slices
cleanly by domain. The seam is where the transactions are, and finding it needs
a measurement rather than a census.

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

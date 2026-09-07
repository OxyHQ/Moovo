# Moovo

Moovo is Oxy's **courier and transport platform**: send packages, food and moves
(mudanzas), fulfilled either by Moovo's own couriers (Glovo style) or by external
providers such as DHL and FedEx. It is not a marketplace.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Moovo specifically. Versions are in `package.json`, never here.

The repo was forked from the Mercaria marketplace shell, so inherited marketplace
code is still on disk (buy/sell, shops, search, cart, checkout and order
surfaces, now on PostgreSQL like everything else). **Treat it as scaffolding,
not as the domain.** The live courier domain is `courier-company`,
`courier-profile`, `job`, `job-offer`, `provider`, `quote` and `address`. See
`HANDOFF.md` for deferred work.

## Packages

| Package | Path | Role |
|---|---|---|
| `@moovo/frontend` | `packages/frontend/` | Expo customer app |
| `@moovo/courier-app` | `packages/courier-app/` | Expo app for couriers, shipped as **Moovo Go** |
| `@moovo/fleet-dashboard` | `packages/fleet-dashboard/` | Fleet and ops dashboard, shipped as **Moovo Hub** |
| `@moovo/tracker-app` | `packages/tracker-app/` | Public parcel-tracking app, shipped as **Moovo Tracker** |
| `@moovo/backend` | `packages/backend/` | Express API (TypeScript, PostgreSQL, Socket.IO) |
| `@moovo/shared-types` | `packages/shared-types/` | Domain DTOs, still largely inherited marketplace shapes awaiting courier replacements |

**The root script names do not match the package names**, which is not guessable
from the tree: `bun run dev:courier` / `build:courier` drive `@moovo/courier-app`
(Go), `bun run dev:hub` / `build:hub` drive `@moovo/fleet-dashboard` (Hub), and
`bun run dev:tracker` / `build:tracker` drive `@moovo/tracker-app` (Tracker).
`dev:frontend` adds `--clear --tunnel`. Shared types build with
`bun run build:shared-types`.

Stack: Expo, NativeWind (Tailwind + postcss), Reanimated, Zustand, TanStack Query
and expo-router on all four apps; Express, PostgreSQL (drizzle-orm +
postgres.js via `@oxyhq/db`), optional Redis and Socket.IO on the backend;
`@oxyhq/bloom` for UI; `@oxyhq/core` (including `@oxyhq/core/server`) and
`@oxyhq/services` for device-first auth. Client id is
`EXPO_PUBLIC_OXY_CLIENT_ID`; backend auth wiring is in
`packages/backend/src/middleware/auth.ts`.

## Databases

**PostgreSQL is the authority.** Every courier domain — providers,
notifications, addresses, shipments, quotes, fleet, jobs, dispatch offers,
moderation, sequences — runs on it, over the 34 tables in migration `0000`.
Schema, conventions and the migration rules are in
`packages/backend/src/db/schema/CONVENTIONS.md`.

**Mongo is GONE — no models, no `mongoose`, no `MONGODB_URI`, no rollback
target.** The cut removed `src/models/`, `lib/db.ts`, `lib/mongo-bootstrap.ts`
and `scripts/seed.ts`; `HANDOFF.md` §4 keeps the record.

`DATABASE_URL` is the only store configuration, and `db/postgres.ts` REFUSES to
open without it rather than defaulting to a local server — a default makes a
misconfigured task boot, report healthy-ish and fail every request. It does not
yet gate BOOT: the server still listens and the expiry sweeper announces itself
as not running. Making it required is a deliberate behaviour change nobody has
taken.

**`/health/ready` asks the store a REAL question** (`select 1`) rather than
inferring reachability from a connection string, and names the dependency in
its 503. The `oxy-moovo` target group health-checks it (matcher 200, 30s,
threshold 3), so it decides whether a task receives traffic.

## Open decisions the Postgres port left, with owners

Two things the port could not decide for itself. Both are recorded here rather
than in a PR body, because a PR body is the one place a statement reliably goes
unread once the PR is merged.

### `job_location_pings` grows without bound, and nothing sweeps it — OWNER: the courier-product decision

The source capped the trail at `JOB_MAX_LOCATION_PINGS` with a `$slice` push.
That cap was a **Mongo document-size** concern: an unbounded array grows one
document until the driver refuses it. A row has no such limit, so the port moved
the cap from the WRITE to the READ — `hydrateJob` returns the most recent N
ascending, byte-identical to what the array held, with nothing destroyed to
produce it (`listRecentLocationPings`).

That is right for the DTO and leaves the table unbounded. Rough size: a 30-minute
delivery pinging every 10s is ~180 rows, so ~180k rows a day at a thousand
deliveries — real growth, on a table nothing reaps.

**It is deliberately NOT registered in `db/expiry.ts` yet, and that is the
decision being recorded, not an omission.** Registering it requires a retention
in seconds, and no defensible number is derivable from this repo: the only
consumer is the sender's own view of their own job, and the number that matters
is how long a courier's route must stay reconstructible for a DISPUTE. Inventing
one silently deletes a customer's evidence at whatever interval somebody guessed.

Closing it is one entry in `EXPIRY_TARGETS` keyed on `job_location_pings.at`
plus a leading btree on that column — the shape `quotes`/`job_offers` already
use. **Whoever sets the dispute window owns this.** Until then the growth is
known and accepted, which is a different thing from unnoticed.

### `START WITH 1` on both sequences must be RE-CONFIRMED at cutover — OWNER: the cutover run

`order_number_seq` and `job_number_seq` start at 1, and that is correct ONLY
because the pre-port census found `counters` empty, with no document for `order`
and none for `job`. That fact was true when it was measured and is exactly the
kind that stops being true quietly.

**Re-run the census (`oxy-moovo-census:1`) against the live database immediately
before the cutover.** A sequence left at 1 against a populated table re-issues
`MRC-000001` and collides with the unique index **at a customer's checkout** —
loud, and at the worst possible moment. If the census finds rows, the sequences
must be set past the highest existing number in the same window, before any
traffic.

## Moovo Tracker

Universal parcel tracking, AfterShip-shaped: somebody pastes a tracking number
from any carrier, Moovo works out whose it is, fetches the checkpoints and shows
one timeline. It ships as its own Expo app but on **this** backend — one Express,
one Postgres, one `@moovo/shared-types`.

**The backend is LIVE; the app is NOT DEPLOYED YET.** The schema, its retention,
the adapters, the detector, the poller, the routes and the webhook all landed and
are serving on the deployed API. `packages/tracker-app` exists and builds, and
`deploy-cloudflare-tracker.yml` is wired — but the Pages project `moovo-tracker`
and the DNS for `tracker.moovo.now` are still handoff, so nothing answers on that
hostname. Everything below names files that are present.

**It is `Moovo Tracker` at `tracker.moovo.now`, and it breaks the `Go`/`Hub`
naming pattern ON PURPOSE.** `Go` and `Hub` are one-syllable ROLE nouns that do
not describe a function, so consistency would name this one `Moovo Track`. The
difference is who each app serves: a courier or a fleet operator is TOLD to
install Go or Hub and never searches for it, while the tracker is the top of the
funnel — the only Moovo surface a stranger reaches without knowing Moovo exists,
by searching "seguimiento de paquete". There the generic noun IS the acquisition
channel, which is why AfterShip, which has a real name, still lists its consumer
app as "AfterShip Package Tracker". Two consequences to carry rather than fix
with the name: "Tracker" does no SEO in Spanish (people search *rastrear
paquete*, so the `<title>`, the store subtitle and the copy do that work, from
the first deploy rather than as later polish), and `.now` is an unfamiliar TLD
for the one surface whose natural use is sharing a link.

Identifiers, matching the existing three: app name `Moovo Tracker`, slug and
Cloudflare Pages project `moovo-tracker`, scheme `moovotracker`, bundle and
package `now.moovo.tracker`.

**Every built-in carrier adapter is DEEP-LINK-ONLY today, and the app must not
claim otherwise.** `built-in-carriers.ts` says so in its header, `TRACKING_ENABLED`
defaults to `false`, and `lookupParcel` therefore creates or reads the shared row
and returns the checkpoints it has — none, for a new number. The tracker app
branches on `carrier.pollSupported` (which is `capabilities.fetch` off the
adapter, stored on the row) rather than hardcoding a "coming soon": `false` says
Moovo does not yet receive that carrier's status and makes the carrier's own page
the primary action, `true` renders the status and the timeline. An empty timeline
labelled "the carrier has not registered any movement" blames the carrier for
Moovo's gap. A carrier gaining a feed flips the row and the app starts rendering
timelines with no change in the app.

**SEUR, GLS and Amazon have NO detection rule, so the carrier picker is the
ordinary path.** Their references collide with too much else, and a rule that
fired on everything would make every number ambiguous. `resolveCarrierOrThrow`
refuses such a number and asks for a `carrierKey`, so without
`components/CarrierPicker.tsx` those carriers are unreachable however prominently
they are listed. The choice is written into the URL (`?carrier=<key>`), not
component state, so it survives a reload and a shared link — and `moovo` is
filtered out of the picker, because a row on the internal pointer key without a
`moovoJobId` is a parcel the detail endpoint can never hydrate.

**The Spanish SEO head lives in `packages/tracker-app/public/index.html`, and
`app/+html.tsx` would be INERT here.** That file is only used when static
rendering is enabled; with `web.output: "single"` — what all four apps ship —
`@expo/cli` builds the shell from `public/index.html` if one exists and its own
default otherwise, substituting `%LANG_ISO_CODE%` and `%WEB_TITLE%` from
`app.json` and appending `expo.web.description`. Writing the head in a
`+html.tsx` compiles, deploys and shows nothing: the crawler gets Expo's default
shell with the bare app name as its title. **Both substitutions are
`String.replace` with a STRING pattern, so only the FIRST occurrence in the file
is replaced** — a comment mentioning `%WEB_TITLE%` above the `<title>` that uses
it silently eats the substitution and ships the raw placeholder as the page
title. Verify by grepping `dist/index.html` after a build, never by reading the
source.

**The cost unit is `(carrier, tracking number)`, not `(user, parcel)`**, and that
is a UNIQUE INDEX rather than a convention. `tracked_parcels` is one shared
identity per number; `tracked_parcel_subscriptions` is what multiplies per
person; the poller claims the identity. A thousand watchers of one parcel are one
carrier call. Making the parcel per-user, or dropping the index because "the
service checks first", removes that silently — everything keeps working and the
bill multiplies. Two concurrent adds both miss a `findOne` and both insert.

**`tracked_parcels` is ALSO the work queue, and there is deliberately no poll
outbox.** The row already has a natural key, a natural due time (`nextPollAt`)
and natural dedupe; a second queue can only drift from the schedule it mirrors.
The lease columns are on the row and the claim is the same
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` statement
`moderationOutboxRepository` uses. The consequence somebody will try to
"simplify": **`status` is the PARCEL's status and NEVER the worker's** — unlike
`moderation_outboxes` there is no `pending`/`processing` on this row, the lease
alone is the claim, and folding the two axes together makes "delivered" and
"currently being fetched" the same fact.

**`tracked_parcels_number_normalised_check` is the constraint that keeps the
dedupe true, and it is worth more than it looks.** The unique index is defeated
by exactly ONE un-normalised write: `1Z999AA1-0123456784` and
`1Z999AA10123456784` become two identities, two schedules and two bills, and a
test that asserts "the row exists" cannot see it. Every write path goes through
the single exported `normalizeTrackingNumber()`, and the CHECK is what makes
forgetting it loud (`23514`) instead of expensive. There is one spelling of that
normalisation, and the CHECK encodes the same expression.

**Anonymous tracking is a one-off LOOKUP and persists nothing per person.** No
subscription row, no notification, no socket room, no device identity to hash and
no bearer credential to store. A signed-out user's recent numbers live on their
phone. The lookup still creates or refreshes the shared parcel row — that is the
cache, and where the deduplication pays — but it is born with
`subscriberCount = 0` and therefore `nextPollAt = NULL`, so it is never fetched
again on its own. **Anonymous costs exactly one call.** Subscribing is the only
thing that arms the poller.

**A carrier that is also a `Provider` is TWO rows, and the catalogues must not be
merged.** `providers` is the registry of carriers Moovo can hand a shipment to:
`quote.service.ts` fans out across every enabled row and `supported_types` is
CHECKed against `SHIPMENT_TYPES`. Seeding Correos there would put a carrier
Moovo has no contract with into a customer's checkout. `tracking_carriers.provider_id`
links the two where they are the same carrier (DHL).

**Moovo's own deliveries are a POINTER, never a copy.** A booked job gets a
`tracked_parcels` row with `carrierKey='moovo'`, `moovoJobId` set,
`pollMode='manual'` and **zero checkpoints for its whole life**; the detail
endpoint hydrates the job through `job-hydration.service.ts` instead, so the live
map and proof of delivery keep working and `job_status_events` keeps exactly one
writer. The row exists so the tracker's list is ONE index scan over subscriptions
rather than a union of two sources with two cursors and every filter written
twice.

### Open decisions, with owners

**How long a tracked parcel is kept — OWNER: the tracker-product decision.**
Unlike `job_location_pings` this one could not be left unregistered:
`tracked_parcels` is the one table in this schema ANY caller can write to by
pasting a string, so its sweep is a bound on an open-ended table rather than a
filing policy. Two numbers therefore ship, in `db/tracking/retention.ts`:
**30 days once nothing watches a parcel** (the figure that actually bounds the
table — typos, abandoned pastes, one-off anonymous lookups) and **180 days past
the terminal event while somebody does** (the figure a product owner must
confirm). Closing this is changing a constant. It carries the same HAZARD
`moderation_outboxes` does, stated in its `EXPIRY_TARGETS` reason: `expiresAt` is
written at WRITE, not at completion, so a poller wedged for a whole window would
have live parcels swept rather than updated. **Alert on poller staleness, not on
the sweep.**

**`sourceKind = 'public_page'` is a LEGAL decision per carrier, not a technical
one — OWNER: legal.** Coverage comes from official carrier APIs where they exist
and from parsing the carrier's own public tracking page where they do not, which
is how a catalogue of hundreds is reachable without an aggregator contract. That
second mode is a per-carrier judgement about that carrier's terms, so it lives in
`tracking_carriers.source_kind` as a stored, operator-editable column: "which
carriers are we parsing" has to be answerable without reading an adapter, and
revocable without a deploy. No carrier is enabled in that mode without someone
approving it.

**`POST /tracking/lookup` is an enumeration surface by design, and what it
REFUSES to return is the part that matters — OWNER: this domain.** Anyone can
probe numbers; the carrier's own website works the same way. That is answered
with a hard per-IP rate limit, and with an ALLOW-LIST of the fields a carrier
response may contribute to a public answer — never the recipient's name, the
delivery address or a signature, whatever the carrier hands us. Written as a
list, compared as an exact set, for the same reason `DELIVERY_FACT_KEYS` is: a
set of "must not contain X" assertions only fails when a named field disappears
and is silent about one somebody ADDS, which is how every real leak arrives.

## CrowdSource moderation

Reports leave Moovo durably, CrowdSource decides them with a randomly drawn jury,
and decisions come back signed. **CrowdSource owns cases, reviews and decisions;
Oxy Trust owns reputation; Moovo owns only its own enforcement actions.**
Everything lives in `packages/backend/src/services/moderation/`, over four models
(`report`, `moderation-outbox`, `moderation-event`, `moderation-enforcement`) and
two routes.

**What is reportable.** The live courier domain is delivered: `courier` and
`customer` (both `identity.profile`) and `delivery` (`custom.moovo.delivery`).
The inherited marketplace nouns (`listing`, `store`, `review`) are accepted by
`POST /reports` and stored, but have **no subject provider**, so they never
leave. Wiring a provider to a model scheduled for deletion buys nothing. The
registry decides DELIVERY, never admission: gating the route on it would break
existing report surfaces on adoption day.

**A delivery is not a `commerce.listing`.** A listing is an offer published to
anyone who looks; a delivery is a private movement of an object between two named
people. Forcing it into the commerce vocabulary tells a jury the wrong thing
about what it is reading. Allegation codes are mapped just as honestly:
`commerce.prohibited_item` genuinely fits, while "the courier drove dangerously"
has no universal code and becomes `other.policy_specific` rather than being bent
into `integrity.*`.

**`subjects/redaction.ts` is the load-bearing file. Read it before touching any
subject provider.** A `Job` carries two contact names, two phone numbers, two
street addresses, two precise coordinate pairs,
`proofOfDelivery.recipientName`, `payment.reference` and the pickup/dropoff
verification codes. None of it reaches a jury; the codes are a CREDENTIAL, not
evidence (the dropoff code is what proves a recipient is the intended one).
Coordinates are **dropped, not coarsened**: the contract would accept two
decimals, but two 1.1 km squares plus a timestamp narrow a household further than
either alone. Geography travels as ONE derived scalar instead, `distanceKm`,
rounded, which answers "did the courier take a detour" and identifies nothing
because a distance is translation invariant.

**`DELIVERY_FACT_KEYS` in `subjects/delivery-context.ts` is THE list of what a
delivery may emit, and the test compares it as an EXACT SET.** That direction is
the point: a list of "must not contain X" assertions only fails when a named
field goes missing, and is silent about a field ADDED, which is how every real
leak arrives (somebody passes an object through and a `contactPhone` rides
along). An exact comparison catches fields nobody has thought to forbid yet.
**When it fails after you added a field, the fix is not to append the key.**
Decide whether an anonymous stranger reviewing a case may see it, and only then
write it down.

**A conduct report names an account but is about an ENCOUNTER.** `contextJobId`
attaches the delivery as context so a jury can answer "was this courier abusive",
which a profile alone cannot support. `ReportIntakeService` verifies server side
that the reporter was the sender or the assigned courier on that job; without
that check any user could attach any job id and have Moovo package a stranger's
delivery into a case. It fails silently (context dropped, report still stored) so
a prober cannot learn which job ids exist.

**Moovo has exactly ONE enforcement lever**, `CourierProfile.status`, and this
integration is its first writer. There is deliberately no `restrict_delivery`: a
collected parcel cannot be un-collected, and cancelling a job mid transit strands
a courier holding somebody's property, so a decision about a delivery becomes
`manual_review`. There is no customer-side lever at all. `suspend_user` is
carried out as `suspend_courier` (privileges only, never the Oxy account) and
recorded under that narrower name. `no_violation` ALWAYS plans a
`reinstate_courier` even when the recommendation is `no_action`, because
otherwise a successful appeal leaves a courier suspended forever with no error
anywhere.

**Two invariants that fail silently if broken:**

- `enqueueModerationOutboxRow` **refuses the root connection**, via
  `requireTransaction` in `db/transactionGuard.ts`. The report and its delivery
  event commit together or not at all; `DatabaseOrTransaction` is a union the
  root handle satisfies, so a caller that forgets to pass `tx` type-checks,
  commits the row alone, and passes any test that only asserts the row exists.
  The discriminator is that only a transaction handle carries `.rollback`,
  which is why the guard is a function rather than a signature.
- The webhook router **must stay mounted before `express.json()`** in
  `index.ts`. The signature covers the bytes that arrived. Guarded by a test
  asserting `typeof req.body === 'undefined'` inside the route, plus one pinning
  the ordering in `index.ts` itself.

**The moderation writes are tested against a REAL PostgreSQL server**
(`services/moderation/__tests__/moderation.realdb.test.ts`), and that is not belt
and braces: **a mocked repository accepts every statement, including ones the
server rejects.** The Mongo-era version of this file was written after an update
naming `updatedAt` under two operators passed a fully green mocked suite and
failed every real write; the engine has changed and the blind spot has not. Any
new moderation write belongs in the `.realdb.test.ts` file, not in a mocked one.

**The outbox enqueue is `ON CONFLICT (id) DO NOTHING`, and a repeat writes
NOTHING — no tuple version, no timestamp, no lock.** Not because a flag was
passed but because there is no update branch to write one. That matters because a
repeat enqueue is ordinary (a transaction retry, two concurrent duplicate
submissions, a reconciliation sweep re-deriving an event) while the dispatcher is
concurrently claiming and renewing leases on those same rows. It is pinned on
`xmin` as well as `updated_at`: a careful `DO UPDATE` setting every column to its
current value would leave `updated_at` alone — `$onUpdate` only fires on a real
change — and still bump the tuple, so `updated_at` alone cannot tell "wrote
nothing" from "wrote the same thing".

**Neither claim-by-unique may RAISE.** The webhook dedupe claim and the
enforcement claim both used to insert and catch a duplicate-key error. In
Postgres a raised `23505` aborts the surrounding transaction, so every later
statement fails with `25P02` — and both run inside one, where a decision plans
SEVERAL actions and one already-claimed action must not abandon the others.
`ON CONFLICT DO NOTHING RETURNING` makes the empty result the answer instead.
The realdb suite asserts the transaction is still USABLE afterwards, because
answering `false` is not on its own evidence that nothing was poisoned.

**The three lease transitions do NOT share count semantics.** `renew` reads a
MATCH count deliberately: two renewals inside one millisecond compute an
identical `leaseUntil`, so a renewal that held its lease perfectly modifies
nothing, and re-spelling it as "did something change" reports a LOST lease that
was never lost — which the dispatcher answers by abandoning delivery mid-flight.
Postgres has one number and it behaves like `matchedCount`, so `renew` ports
exactly; `complete` and `fail` coincide with it only because they always move
`status` off `processing`, which is an ARGUMENT rather than a construction. A
test comparing two numbers cannot check that argument, so each transition is
called TWICE and the second call is asserted on `updated_at` and `xmin`.

**`decisionRevision` started working at the cutover, and had never held before.**
`ReportSchema` declared no such path, so Mongoose's strict mode stripped it from
every `$set`: the column was never stored and the `{decisionRevision: {$lt: n}}`
arm of the guard could never match, so every late delivery of an EARLIER revision
was applied — a retried suspension could overwrite an accepted appeal's
`dismissed` with `resolved`, and the report would say the courier was found in
violation of something they had been cleared of. Storing the column makes the
refusal real. That is a behaviour CHANGE, not a faithful port, and both
directions are pinned in the realdb suite.

**Env:** `CROWDSOURCE_ENABLED` (requires BOTH the service key and the webhook
secret to take effect), `CROWDSOURCE_SERVICE_KEY`, `CROWDSOURCE_BASE_URL`,
`CROWDSOURCE_WEBHOOK_SECRET`, `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`,
`CROWDSOURCE_OUTBOX_BATCH_SIZE`, `CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS`,
`CROWDSOURCE_ENFORCEMENT_MODE` (default `observe`). **There is no
`CROWDSOURCE_APP_ID`, and never add one**: `applicationId` is read off the
credential, and a surface able to carry one is the cross-tenant write the tenancy
model exists to prevent.

## Deploy

- **API** to AWS ECS Fargate via `.github/workflows/deploy-aws.yml`
  (`linux/arm64`, ECR `oxy/moovo`). The ECS service, task definition, ALB rule,
  ECR repo and SSM params must be provisioned in `oxy-infra` first (handoff).
- **Four separate Cloudflare Pages projects**, one workflow each, all using
  `wrangler pages deploy`:

  | Workflow | Package | Pages project |
  |---|---|---|
  | `deploy-cloudflare.yml` | `packages/frontend` | `moovo` |
  | `deploy-cloudflare-go.yml` | `packages/courier-app` | `moovo-go` |
  | `deploy-cloudflare-hub.yml` | `packages/fleet-dashboard` | `moovo-hub` |
  | `deploy-cloudflare-tracker.yml` | `packages/tracker-app` | `moovo-tracker` |

  Each project and its DNS must be created before the workflow can succeed
  (handoff). A change to the shared frontend stack usually needs all four
  redeployed, not just `deploy-cloudflare.yml`.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  build on every push and PR.

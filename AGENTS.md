# Moovo

Moovo is Oxy's **courier and transport platform**: send packages, food and moves
(mudanzas), fulfilled either by Moovo's own couriers (Glovo style) or by external
providers such as DHL and FedEx. It is not a marketplace.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Moovo specifically. Versions are in `package.json`, never here.

The repo was forked from the Mercaria marketplace shell, so inherited marketplace
code is still on disk (`cart`, `listing`, `order`, `product-variant`, `category`
models, plus buy/sell, shops, search and checkout surfaces). **Treat it as
scaffolding being deleted, not as the domain.** The live courier domain is
`courier-company`, `courier-profile`, `job`, `job-offer`, `provider`, `quote` and
`address`. See `HANDOFF.md` for deferred work.

## Packages

| Package | Path | Role |
|---|---|---|
| `@moovo/frontend` | `packages/frontend/` | Expo customer app |
| `@moovo/courier-app` | `packages/courier-app/` | Expo app for couriers, shipped as **Moovo Go** |
| `@moovo/fleet-dashboard` | `packages/fleet-dashboard/` | Fleet and ops dashboard, shipped as **Moovo Hub** |
| `@moovo/backend` | `packages/backend/` | Express API (TypeScript, MongoDB, Socket.IO) |
| `@moovo/shared-types` | `packages/shared-types/` | Domain DTOs, still largely inherited marketplace shapes awaiting courier replacements |

**The root script names do not match the package names**, which is not guessable
from the tree: `bun run dev:courier` / `build:courier` drive `@moovo/courier-app`
(Go), and `bun run dev:hub` / `build:hub` drive `@moovo/fleet-dashboard` (Hub).
`dev:frontend` adds `--clear --tunnel`. Shared types build with
`bun run build:shared-types`.

Stack: Expo, NativeWind (Tailwind + postcss), Reanimated, Zustand, TanStack Query
and expo-router on all three apps; Express, Mongoose, optional Redis and
Socket.IO on the backend; `@oxyhq/bloom` for UI; `@oxyhq/core` (including
`@oxyhq/core/server`) and `@oxyhq/services` for device-first auth. Client id is
`EXPO_PUBLIC_OXY_CLIENT_ID`; backend auth wiring is in
`packages/backend/src/middleware/auth.ts`.

## MongoDB

Database `moovo-production`, passed to `mongoose.connect()` via `dbName` and
**not** embedded in `MONGODB_URI`. See `packages/backend/src/lib/db.ts`.

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

- `enqueueModerationOutboxEvent` **throws unless `session.inTransaction()`**. The
  report and its delivery event commit together or not at all; a bare
  `startSession()` type-checks, commits the row alone, and passes any test that
  only asserts the row exists.
- The webhook router **must stay mounted before `express.json()`** in
  `index.ts`. The signature covers the bytes that arrived. Guarded by a test
  asserting `typeof req.body === 'undefined'` inside the route, plus one pinning
  the ordering in `index.ts` itself.

**The moderation writes are tested against a REAL MongoDB replica set**
(`vitest.globalSetup.ts` plus `moderation-durability.mongo.test.ts`), and that is
not belt and braces: **a mocked `updateOne` accepts every update document,
including ones the server rejects.** Demonstrated in tree by injecting Mention's
bug (naming `createdAt` and `updatedAt` in `$setOnInsert` against a
`{ timestamps: true }` schema): the mocked suite stays fully green while the real
server suite fails ten tests with `MongoServerError: Updating the path
'updatedAt' would create a conflict at 'updatedAt'`, zero rows written, and
inside the intake transaction the abort takes the `Report` with it, so
`POST /reports` 500s for every caller from the first one. Any new moderation
write belongs in the `.mongo.test.ts` file, not in a mocked one.

**The outbox enqueue passes `{ upsert: true, session, timestamps: false }` and
writes BOTH timestamps explicitly. There are two fixes for the conflict above and
they are NOT interchangeable; this is the right one.** Dropping the explicit
fields also clears the error, and leaves Mongoose's own `$set: { updatedAt }` on
the update, which turns a repeat enqueue for an existing row into a real WRITE
rather than a no-op. Measured here on a replica set: the second enqueue moved
`updatedAt` by 38 ms, and a transaction re-enqueueing while an outside writer
touched the same row died with `MongoServerError: operation exceeded time limit`
on the row lock. A repeat enqueue is ordinary (a transaction retry, two
concurrent duplicate submissions, a reconciliation sweep re-deriving an event)
while the dispatcher is concurrently claiming and renewing leases on those same
rows, so this is a live path, not an exotic one. Both halves are pinned by tests
(`leaves updatedAt UNTOUCHED on a repeat enqueue`, `does not block a concurrent
writer on the same row`). Credit: `homiio`, via `@oxyhq/crowdsource-app`
(CrowdSource PR #34).

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
- **Three separate Cloudflare Pages projects**, one workflow each, all using
  `wrangler pages deploy`:

  | Workflow | Package | Pages project |
  |---|---|---|
  | `deploy-cloudflare.yml` | `packages/frontend` | `moovo` |
  | `deploy-cloudflare-go.yml` | `packages/courier-app` | `moovo-go` |
  | `deploy-cloudflare-hub.yml` | `packages/fleet-dashboard` | `moovo-hub` |

  Each project and its DNS must be created before the workflow can succeed
  (handoff). A change to the shared frontend stack usually needs all three
  redeployed, not just `deploy-cloudflare.yml`.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  build on every push and PR.

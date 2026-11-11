<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Moovo Tracker

Universal parcel tracking, AfterShip-shaped: somebody pastes a tracking number
from any carrier, Moovo works out whose it is, fetches the checkpoints and shows
one timeline. It ships as its own Expo app but on **this** backend — one Express,
one Postgres, one `@moovo/shared-types`.

**LIVE at `tracker.moovo.now` since 2026-09-07**, backend and app both. The
schema, retention, adapters, detector, poller, routes and webhook serve from
`api.moovo.now`; `packages/tracker-app` deploys to the Pages project
`moovo-tracker` via `deploy-cloudflare-tracker.yml`. Everything below names
files that are present.

**What is live is DETECTION AND DEEP LINKING, not status.** `/tracking/carriers`
answers with 22 carriers and `pollSupported: false` on every one of them, so a
lookup identifies the carrier, stores the shared row and returns that carrier's
own tracking URL — never a checkpoint. FedEx is the one that can change that,
and only with credentials plus an operator flipping its column; see the carrier
section below. The invariants that follow describe the whole design.

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

**COVERAGE is cheap; DETECTION is not, and they are separate decisions.** The
catalogue carries 22 public carriers — the Spanish and US ones people actually
paste — because naming and linking a carrier costs one entry in
`built-in-carriers.ts`. A `detect` rule costs correctness: `resolveDetection` is
decisive only when ONE carrier claims a number, or when exactly one claimant
passes a check digit, so every overlapping shape-only rule turns a number that
used to resolve into a question. Most Spanish carriers (Correos Express, MRW,
Nacex, CTT, DHL Parcel, Paack, Envialia, Tipsa, Zeleris) therefore carry NO
detect: their references are bare digit runs that collide with each other and
with Correos' own domestic format.

One overlap is deliberate and is an IMPROVEMENT: USPS claims `9[2345]`-prefixed
IMpb labels, which FedEx's `\d{20}`/`\d{22}` rule also claims. Before `usps`
existed FedEx was the only claimant and was picked SILENTLY — a USPS parcel
polling FedEx forever and showing "no information". Two claimants and a question
beats one claimant and a wrong answer.

**A carrier without a detection rule is reached ONLY through the picker.**
`resolveCarrierOrThrow` refuses an undetectable number and asks for a
`carrierKey`, so without `components/CarrierPicker.tsx` those carriers are
unreachable however prominently they are listed. The choice is written into the
URL (`?carrier=<key>`), not component state, so it survives a reload and a shared
link.

**`moovo` is refused as a carrier key on every public input path**, by
`requireSelectableCarrier` in `tracking.service.ts` and by leaving it out of
`listCarriers()`. It is the internal POINTER key: those rows carry a
`moovoJobId` and zero checkpoints for life, and `getParcelDetail` hydrates the
job instead — so a row created on that key with no job behind it can never be
hydrated and falls through to an empty carrier timeline forever. A Moovo parcel
is created by BOOKING, never by pasting. The guard is deliberately SEPARATE from
`requireCarrier`: reading an existing pointer must keep working, and a blanket
ban inside `requireCarrier` would break every Moovo delivery in every customer's
list. `POST /tracking/lookup` is public and unauthenticated, so the app's picker
filtering the key was never the rule — the service is.

**FedEx is the only adapter that CAN fetch, and three independent things gate
it.** Every other built-in adapter is deep-link-only. `adapters/fedex.ts` gains
`fetch` only when `FEDEX_CLIENT_ID` and `FEDEX_CLIENT_SECRET` are BOTH set;
without them it is byte-for-byte the deep-link carrier this build has always
shipped, which is a working product rather than a degraded one. Beyond
credentials it needs `TRACKING_ENABLED=true`, and — the one that actually decides
— `tracking_carriers.poll_supported` on the `fedex` row, which seeding never
updates (`ON CONFLICT DO NOTHING`). **Its response mapping is pinned by fixtures
written from FedEx's published shape, which test THIS CODE'S READING of that
shape and not FedEx.** One live call with real credentials confirms or corrects
it; until then the column stays `false`.

**The app must not claim status it does not have.** The tracker app branches on
`carrier.pollSupported` (which is `capabilities.fetch`, stored on the row) rather
than hardcoding a "coming soon": `false` says Moovo does not yet receive that
carrier's status and makes the carrier's own page the primary action, `true`
renders the status and the timeline. An empty timeline labelled "the carrier has
not registered any movement" blames the carrier for Moovo's gap. A carrier
gaining a feed flips the row and the app starts rendering timelines unchanged.

**The Spanish SEO head lives in `packages/tracker-app/public/index.html`, and
`app/+html.tsx` would be INERT here.** That file is only used when static
rendering is enabled; with `web.output: "single"` — what all four apps ship —
`@expo/cli` builds the shell from `public/index.html` if one exists and its own
default otherwise, substituting `%LANG_ISO_CODE%` and `%WEB_TITLE%` from
`app.json` and appending `expo.web.description`. Writing the head in a
`+html.tsx` compiles, deploys and shows nothing: the crawler gets Expo's default
shell with the bare app name as its title.

**Every injection is `String.replace` with a STRING pattern, so only the FIRST
occurrence in the file is replaced, and there are FOUR targets:**
`%LANG_ISO_CODE%`, `%WEB_TITLE%`, `</head>` (description, theme colour, the CSS
links, the favicon) and `</body>` (the bundle scripts). The template therefore
carries NO PROSE — a comment mentioning one of them consumes that injection.
Both halves of that have already happened: a comment naming `%WEB_TITLE%` shipped
the raw placeholder as the title, and a comment naming `</head>` swallowed the
Tailwind stylesheet, which boots fine (scripts go before `</body>`) and renders
every screen unstyled — `bg-background` transparent, `text-foreground` black on
Bloom's dark ground, indistinguishable from "the UI does not load".

`deploy-cloudflare-tracker.yml` asserts the title and the stylesheet in the
exported `dist/index.html`, so this fails the build rather than the page. Verify
by grepping the BUILD OUTPUT, never by reading the template.

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

**Env:** `TRACKING_ENABLED` (default `false`; requires BOTH the flag and a
registered adapter that can fetch), `TRACKING_POLL_INTERVAL_MS`,
`TRACKING_POLL_BATCH_SIZE`, `TRACKING_POLL_LEASE_MS`, `TRACKING_FETCH_TIMEOUT_MS`,
`TRACKING_MAX_CONSECUTIVE_FAILURES`, `TRACKING_MAX_NOT_FOUND_STREAK`,
`TRACKING_NOT_FOUND_MIN_AGE_MS`, `TRACKING_STALE_AFTER_MS`, and the FedEx pair
`FEDEX_CLIENT_ID` / `FEDEX_CLIENT_SECRET` with optional `FEDEX_BASE_URL`
(`https://apis.fedex.com`; the sandbox is a different HOST, not a flag).

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


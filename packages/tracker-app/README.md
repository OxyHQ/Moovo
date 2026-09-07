# Moovo Tracker

Universal parcel tracking, shipped as its own Expo app on **this** backend —
one Express, one Postgres, one `@moovo/shared-types`. Somebody pastes a tracking
number from any carrier, Moovo works out whose it is, fetches the checkpoints and
shows one timeline.

Lives at **`tracker.moovo.now`**.

## Why this app is different from Go and Hub

`Go` and `Hub` are one-syllable role nouns for people who are TOLD to install
them. The tracker is the top of the funnel: the only Moovo surface a stranger
reaches without knowing Moovo exists, by searching *seguimiento de paquete*.
That has two consequences you will see all over this package and should not
"fix":

- **The UI copy is Spanish**, including the `<title>`, the description and the
  JSON-LD in `app/+html.tsx`. "Tracker" does no SEO in Spanish — people search
  *rastrear paquete* — so the copy does that work, from the first deploy rather
  than as later polish.
- **Everything works signed out.** Pasting a number and reading the timeline
  never needs an account. Signing in buys a saved list and notifications, and is
  never a wall in front of the answer.

## Anonymous tracking persists nothing per person

`POST /tracking/lookup` is a one-off question: no subscription row, no
notification, no socket room, no device identity. It refreshes the SHARED parcel
row — the cache every later watcher benefits from — and costs exactly ONE carrier
call. A signed-out visitor's recent numbers therefore live on their device, in
`lib/recents.ts`.

**Subscribing (`POST /tracking/parcels`) is the only thing that arms the poller.**

## The normalisation lives on the server

There is exactly one spelling of `normalizeTrackingNumber`, in
`services/tracking/carrier-detection.ts`, and a CHECK constraint encodes the same
expression. This app therefore sends the RAW string the visitor pasted and
displays the number the SERVER returned. Re-implementing the rule here to pretty
up a URL would create a second spelling, and a client and server that disagree
about what "the same number" means is how the dedupe that makes a parcel cost one
carrier call quietly stops holding.

`lib/recents.ts` stores the server's number for the same reason.

## Routes

| Route | Auth | What it is |
|---|---|---|
| `/` | none | The landing and the paste box — the top of the funnel |
| `/track/[number]` | none | The anonymous result, optionally `?carrier=<key>`. `noindex`: it is one visitor's parcel |
| `/parcels` | required | The signed-in user's saved parcels |
| `/parcels/[id]` | required | One parcel. `[id]` is the SUBSCRIPTION id, never the shared parcel's |

`/track/`, not `/t/`: the backend's own `moovo` deep-link template already spells
it that way (`adapters/built-in-carriers.ts`), and one spelling of the tracker's
URL is worth more than four saved characters.

## Commands

From the repo root — note the script names do not match the package name, in
keeping with `dev:courier` / `dev:hub`:

```bash
bun run dev:tracker     # expo start --scheme moovotracker
bun run build:tracker   # expo export --platform web
```

## Deploy

Cloudflare Pages project `moovo-tracker`, via
`.github/workflows/deploy-cloudflare-tracker.yml`. The project and its DNS must
exist before the workflow can succeed (handoff) — see `HANDOFF.md`.

## `public/index.html` is a SUBSTITUTION TARGET, so it carries no prose

With `web.output: "single"` — what all four apps ship — `app/+html.tsx` is never
rendered. A head written there compiles, deploys and shows nothing. `@expo/cli`
reads `public/index.html` as its template instead, and fills it in with plain
`String.replace` and STRING patterns, which replace only the FIRST occurrence:

| Target | What Expo puts there |
|---|---|
| `%LANG_ISO_CODE%` | `expo.web.lang` |
| `%WEB_TITLE%` | `expo.web.name` |
| `</head>` | `expo.web.description`, `themeColor`, the CSS `<link>`s, the favicon |
| `</body>` | the bundle `<script>`s |

**So the file must not contain those four strings anywhere except where they
belong.** This has bitten twice. A comment mentioning `%WEB_TITLE%` above the
`<title>` shipped the raw placeholder as the page title. A comment mentioning
`</head>` swallowed the Tailwind stylesheet into itself — the app still booted,
because scripts go before `</body>`, and rendered every screen unstyled:
`bg-background` transparent and `text-foreground` defaulting to black on Bloom's
dark ground, which looks exactly like "the UI does not load".

The deploy workflow asserts both after the export, so a template that eats an
injection fails the build instead of shipping. **Explanations belong in this
file, not in the template.**

## `carrier.pollSupported` decides what the UI may claim

**Every built-in adapter is deep-link-only today.** `built-in-carriers.ts` says
so in its header, `TRACKING_ENABLED` defaults to `false`, and `lookupParcel`
consequently creates or reads the shared row and returns the checkpoints it has
— which for a new number is none. Nothing fetches from a carrier yet.

So the app branches on `carrier.pollSupported`, which is `capabilities.fetch` off
the adapter, stored on the row and hydrated onto every carrier summary:

- **`false`** — say that Moovo does not yet receive this carrier's status, and
  make "Ver el seguimiento en <carrier>" the primary action. Do NOT render an
  empty timeline with "el transportista todavía no ha registrado ningún
  movimiento": that blames the carrier for a gap that is Moovo's. The notify
  switch is disabled for the same reason — no feed, no state change, nothing to
  promise.
- **`true`** — the status, the hint and the timeline, as written.

A carrier gaining a feed flips the row and this app starts showing timelines with
no change here. **Do not hardcode a "coming soon" anywhere**; the wire already
carries the answer.

## Carrier selection is the ordinary path, not an edge case

SEUR, GLS and Amazon carry **no detection rule at all** — their references
collide with too much else, and a rule that fires on everything would make every
number ambiguous. `resolveCarrierOrThrow` therefore refuses those numbers and
asks for a `carrierKey`. Without `components/CarrierPicker.tsx` they are
unreachable however prominently the landing page lists them.

The selection is written into the URL (`?carrier=<key>`) rather than component
state, so the choice survives a reload and a shared link. `moovo` is filtered out
of the picker: it is the internal pointer carrier, and a row on that key without
a `moovoJobId` is a parcel the detail endpoint can never hydrate.

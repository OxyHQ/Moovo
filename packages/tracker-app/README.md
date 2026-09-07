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
| `/t/[number]` | none | The anonymous lookup result. `noindex`: it is one visitor's parcel |
| `/parcels` | required | The signed-in user's saved parcels |
| `/parcels/[id]` | required | One parcel. `[id]` is the SUBSCRIPTION id, never the shared parcel's |

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

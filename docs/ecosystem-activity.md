# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Activation follows IDENTITY, not a separate flag and no longer a credential
pair: set `AWS_REGION`, and collection runs wherever the process can act as the
Oxy application `moovo`. There are two ways to be it, and a deployment has one
of them without anybody configuring it — on ECS the task role attests and no
secret exists anywhere (oxy ADR 0026), while a local checkout presents an
`OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET` pair. A process with neither
disables collection and emits a warning; it must not be interpreted as zero
traffic.

**The deployed API carries neither variable, and gating on them would be the
silent failure this page warns about.** A check for the pair reads an attesting
task as unconfigured, publishes nothing, and puts one warning in a log — while
the dashboard shows a service with no traffic and no infrastructure, which is
indistinguishable from a service nobody is using.

HTTP middleware is mounted before body parsers and routers, including public
routes, webhooks, failures and authenticated internal calls. Outgoing fetch and
Node HTTP requests are observed by the shared SDK, including requests made by
background workers. Socket.IO message sends and receives are observed where
this service exposes Socket.IO. Internal/external scope is independent of
inbound/outbound direction; media is a separate activity category.

Only bounded aggregate fields leave the service. No bodies, message contents,
user identifiers, tokens or IP addresses are added to activity events. Visitor
origins represent the Cloudflare edge PoP, not an IP-derived country. Infrastructure
location follows `AWS_REGION`; registration and graceful removal update the
shared inventory, and crashed instances expire through the API registry.

The publisher does not observe database wire traffic, raw TCP, HTTP/2, WebRTC,
or a separate process that has not installed the collector. These transports
must not be represented by fabricated lines.

## Cloudflare edge requests

Every deployed frontend request, including static files, runs the shared `@oxy.so/telemetry/edge` observer. Workers use `run_worker_first = true`; Pages builds emit a bundled Advanced Mode `_worker.js` with `_routes.json` including `/*`. The original asset handler still owns responses, redirects, streams, MIME handling and cache headers. This increases Worker/Functions invocations for static requests.

Configure **server-only** bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optionally `OXY_EDGE_ACTIVITY_API_URL` (default `https://api.oxy.so`). Use a dedicated activity credential, separate from the backend application credential. Never place these bindings in public Expo/Vite variables or committed files. Enabled publication failures emit a fixed error while preserving website availability. Deployment and valid credentials are required before this is live; a code merge alone does not enable coverage.

Each completed response publishes a batch with incoming and outgoing counters through `ctx.waitUntil`. Failed handlers count only the incoming request. Health, collector and authentication control requests are excluded. No URLs, payloads, IP addresses, user identifiers or query strings are sent. Cloudflare `request.cf.colo` identifies the serving PoP; the visitor endpoint stays unknown, so external static activity is a PoP pulse, not a fabricated geographic arc. Credentials and counters never enter frontend bundles.

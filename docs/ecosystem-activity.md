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

## Cloudflare web traffic

The four web apps (Pages projects `moovo`, `moovo-go`, `moovo-hub`,
`moovo-tracker`) are measured **keylessly** by Oxy: oxy-api reads their traffic
from Cloudflare's own analytics and feeds the ecosystem activity collector (see
OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`). The apps hold no Oxy
activity secret and run no activity code; each `worker/index.js` only fixes
asset MIME fallbacks and cache headers.

The `OXY_EDGE_ACTIVITY_*` bindings of the retired edge observer were never
provisioned and nothing reads them now. If an operator ever finds one on a
deployment, it can simply be deleted.

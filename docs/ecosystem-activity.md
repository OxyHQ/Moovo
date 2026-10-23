# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Activation follows the registered workload identity. Set `AWS_REGION`; the ECS
role `oxy-moovo-task` attests with its administratively bound environment (Oxy
ADR 0049). Own services need no OAuth scopes, application grants or customer key
pairs. The shared temporary AWS role provider also supports authenticated development/SSO
roles. A missing region omits only telemetry; missing/revoked identity follows the
shared retry policy and must not be read as zero traffic. The same provider
authenticates Files references, whose durable outbox retries failed requests.

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

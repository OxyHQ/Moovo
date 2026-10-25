# Own Oxy authority

[Oxy ADR 0049](https://github.com/OxyHQ/oxy/blob/main/docs/adr/0049-first-party-platform-authority.md)
is the platform authority contract. Moovo's registered workload authenticates
its service identity with an administratively bound environment. Own services
need no OAuth scopes, app grants or inter-app consent. External customer OAuth,
carrier API credentials and signed provider webhooks keep their own contracts.

The four applications use their one OxyProvider session through
`createLinkedClient().fetchOptional`. Axios keeps response/error compatibility;
the shared SDK owns tokens, refresh, account changes, cancellation, destination
validation and cookie exclusion. Signed-out tracking stays anonymous. No local
token getter or Authorization interceptor remains.

The backend uses shared Oxy session middleware. The unused service-secret,
Telegram raw-user-header and local scope middleware were removed after checking
all production imports; no active bot flow used them. CrowdSource's shared
factory resolves the tenant from live workload identity. Telemetry and Files
reference delivery require an attestable workload; customer keys do not become
own service identity. Existing delivery, company membership, shipment ownership,
material transport and financial rules are unchanged.

## Release gate

The application lockfile uses published core7.1/contracts6/services13 and
protocol1.5.1, with CrowdSource SDK3.1/contracts1.1.1. The four app adapters use
the shared optional linked fetch, preserving anonymous reads and session-bound
writes. No candidate tarball is committed. Moovo SDK0.3 declares its tested
Oxy peer as >=7 <8; standalone external clients keep their existing
explicit credential callback. Moovo contracts0.2.1 and SDK0.3 use the patched
Zod4.6.7 floor.

Validation against the published registry packages: 79 backend suites, 924 passing tests and one existing
opt-in browser test skipped; 416 Bun tests across 43 files; SDK and four-app
HTTP transport tests (seven total). The HTTP tests cover anonymous calls,
refresh, account switches, forged header removal, cancellation, foreign origins
and Axios error envelopes. Backend and SDK builds and typechecks passed, as did TypeScript checks for all
four applications.

The final full run used two local worker processes and passed all 79 suites
without diagnostic instrumentation. An earlier concurrent run exhausted the
shared local PostgreSQL connection limit; two subsequent teardown timeouts were
investigated with per-stage timing (32 pools closed within 19 ms, database drops
within 993 ms). No timeout, assertion or database guard was relaxed. The receiver
HTTP fixture now disposes its Oxy client, so it exits without a leaked feed.

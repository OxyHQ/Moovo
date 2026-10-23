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

Candidate validation used Oxy core 7/contracts 6 including the optional linked
fetch contract (`d44ecbe4d`) and CrowdSource SDK source `99db506ab`. Publish the
shared SDK changes and update registry pins/lockfile before deploying this
source. Temporary tarball paths are not committed. The Moovo SDK peer range
accepts core 7 while retaining supported earlier external consumers.

Validation: 79 backend suites by union, 925 passing tests and one existing
opt-in browser test skipped; 417 Bun tests across 43 files; SDK and four-app
HTTP transport tests (seven total). The HTTP tests cover anonymous calls,
refresh, account switches, forged header removal, cancellation, foreign origins
and Axios error envelopes. Backend and SDK builds and typechecks passed, as did TypeScript checks for all
four applications.

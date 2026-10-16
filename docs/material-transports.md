# Transport for accepted Mercaria donations

Moovo owns transport proposals, quotes, payer authorizations and courier jobs.
Mercaria owns donation offers and quantity reservations. An accepted reservation
can request one active Moovo transport; Mercaria stores only its opaque ID.
Personal collection remains available, without a transport charge. Donation
materials themselves have no price or payment.

## Contract and access

`packages/contracts` defines the versioned `/api/v1` routes, validation and
OpenAPI. `packages/sdk` bundles these contracts for ESM, CJS, browsers and React
Native. See its README for `.transports.create/get/byReservation/quote/authorize/
book/cancel` signatures. `moovoForOxy` uses Oxy's official linked client; product
frontends send user writes directly to Moovo. No product backend forwards a
bearer manually, persists a user's token, or writes to the other product.

For each source read the backend creates a request-local Oxy client and invokes
Mercaria's SDK against `MERCARIA_API_URL` (default `https://api.mercaria.co`).
This is a live, authorized read of the reservation. Source content is not
replicated. Organization authority is checked without Oxy response caching:
owner relationship or active owner/admin membership can approve expenditure;
editors can prepare proposals but cannot approve expenditure. The source read
must authorize the acting donation participant. A sponsor must be an Oxy
organization; selecting another person as sponsor cannot authorize them.

The user supplies missing structured addresses, coordinates, contacts and parcel
facts. Mercaria's pickup instructions are freeform notes, never a guessed
address or location. Moovo stores these as its own fulfillment proposal; the
job's address/parcel/quote snapshots are lawful fulfillment history frozen at
booking after explicit payer approval, not a cache of Mercaria content.

The selected donor, recipient or sponsoring organization approves the exact
quote ID, integer amount, FAIR currency and expiry, with `confirmed: true`.
Sponsors can review and approve a Moovo proposal without receiving Mercaria's
private instructions through its API. A donor/recipient then requests the actual
booking; Moovo rechecks the reservation is accepted immediately before booking.
There is no cross-database transaction: the two product actions remain separate,
and cancelling a reservation must never claim to cancel an already requested
transport. Generic `/shipments` booking cannot bypass material payer approval:
the integration passes an internal-only invocation argument and deterministic key.

## Prices and payment

This integration uses the existing **real internal courier dispatch** path and
its current FAIR pricing. Moovo's `fairMinor` uses **100 units per FAIR**, unlike
Mercaria's money contract. `formatTransportPrice` owns this conversion; consumers
must not feed these amounts into Mercaria's money formatter.

The request creates an actual Moovo courier job and dispatch offers. It reports
`paymentStatus: pending`, `paymentCollectionAvailable: false`. No card capture or
charge is performed or claimed. External provider adapters in this repository
are still simulated; their quotes are excluded from this integration. Production
provider/payment validation is not implied by the local tests.

## Retry and cancellation semantics

- Shipment and proposal admission share one PostgreSQL transaction, a reservation
  advisory lock and unique active-reservation/operation constraints. Same payload
  and operation return the same request; changed payload under that key conflicts.
- Quote failures or process termination recover the same shipment. A durable
  quote lease expires after 30 seconds; saved quotes recover a lost response.
- Approval expires with the exact quote. Renewing an expired quote clears every
  approval field. The payer must approve the new price explicitly.
- Booking uses `material_<transport-id>` and provider operation
  `shipment_<shipment-id>`. A durable shipment claim and globally unique caller
  key precede any external carrier I/O. Lost external responses stay `unknown`;
  they must be reconciled with that operation ID, never blindly retried.
- Own-courier admission and all effects commit in one local transaction. Recovery
  after the proposal’s 30-second lease is safe, including old interrupted claims.
  A database row lock fences old workers against cancellation/renewed approval.
  Job, history, tracking pointer, quote/shipment markers and booked proposal state
  commit together; a deterministic insert converges repeated recovery on one job.
- `get` also discovers a committed job after a lost HTTP response. It always
  reads the current Moovo job status. Client errors hide old displayed data.
- `cancel` only cancels an unbooked proposal. Booked or uncertain deliveries must
  be managed in Moovo. Only explicit proposal cancellation permits a new operation
  for the reservation. Replaying the old operation returns that cancelled proposal.

## Build, rollout and verification

Generated migration `0010_material_transport_reservations` is additive and runs
before deployment. The previous release’s `0007` and `0009` post migrations must
already be applied before a normal pre-deploy rollout; do not bypass that production guard. Empty disposable smoke
databases bootstrap the complete history before checking both deployment phases. They
create transport/booking admission state and enforce the approval shape and
booking keys. The API recipe copies contracts and every workspace manifest
before installation; contracts are inlined into its backend bundle. The owning
Mercaria SDK is installed from the registry at exact version `0.4.0`.

The transport real-DB suite uses migrated PostgreSQL, actual HTTP, the SDK and
request-local official Oxy-linked clients. It covers quantity-source access,
payer authority, exact quotes, quote failure/restart, concurrent requests,
booking recovery, cancellation and external ambiguous results. Canonical
`https://mercaria.co` preflight/success/error CORS headers are asserted. Set
`MOOVO_TEST_BROWSER=1` with Playwright Chromium installed to additionally enforce
preflight in a real browser against the actual API server. `TEST_DATABASE_URL`
must point to a disposable local PostgreSQL admin database; suites create and
drop their own databases. These tests do not book a production shipment.

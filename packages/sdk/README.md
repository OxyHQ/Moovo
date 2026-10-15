# Moovo transport SDK

`@oxy.so/moovo-sdk` is Moovo's canonical transport client. Its bundled schemas come
from `@oxy.so/moovo-contracts`; consumers do not copy transport metadata into their
own databases. Use `moovoForOxy(oxyServices)` in an authenticated Oxy application
and dispose the returned linked client with its component/request lifecycle.

```ts
const linked = moovoForOxy(oxyServices);
const proposal = await linked.transports.create({
  reservationId, actingAccountId, payerAccountId, operationId,
  pickup, dropoff, parcel, itemDescription,
});
// Display the current quote and selected payer. A human payer explicitly confirms.
const quote = proposal.quotes[0];
await linked.transports.authorize(proposal.id, {
  actingAccountId: payerAccountId, quoteId: quote.id,
  amountMinor: quote.amountMinor, currency: quote.currency, confirmed: true,
});
// A reservation participant requests fulfillment after the payer's approval.
await linked.transports.book(proposal.id, { actingAccountId });
linked.dispose();
```

Endpoints require actual structured pickup/delivery addresses, coordinates and
contacts, plus parcel weight, pieces and size. Freeform Mercaria pickup
instructions are notes, never geocoded or invented coordinates. Use the current
user's authenticated linked client for writes directly to Moovo.

Methods under `.transports`: `create(input)`, `get(id, accountId)`,
`byReservation(reservationId, accountId)`, `quote(id, {actingAccountId})`,
`authorize(id, approval)`, `book(id, {actingAccountId})`, and
`cancel(id, {actingAccountId})`. The latter cancels an unbooked proposal; it never
cancels a courier job. Typed errors are `MoovoApiError`.

Writes do not retry automatically. Keep the same creation `operationId` for the
same intent. On lost responses, resolve `byReservation`/`get`; do not generate a
new operation. The server deduplicates active Mercaria reservation IDs and books
with a deterministic transport operation. Only an explicitly cancelled proposal
allows a new operation. Quotes and payer approvals expire; changing the quote
requires a new explicit approval. Own-courier interrupted bookings can recover
the same operation after the 30-second lease, without a duplicate job.

`TransportView` includes Moovo-owned proposal details, current quote, exact payer
approval and current job status. Persist its opaque `id` only in the referring
product. `paymentStatus` is `pending` and `paymentCollectionAvailable` is false:
requesting fulfillment does **not** collect or claim a payment. Currency is FAIR,
matching Moovo's own-courier quote domain: **100 minor units per FAIR**,
not Mercaria's 100,000,000. Use `formatTransportPrice(quote, locale)` to display
this amount; never pass it to another product's money formatter. External carrier adapters are excluded
from this integration until real booking adapters are operational.

The generated API description is `packages/contracts/openapi.json` and served at
`/api/v1/openapi.json`. No package is published by the development build.

<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# CrowdSource moderation

Reports leave Moovo durably, CrowdSource decides them with a randomly drawn jury,
and decisions come back signed. **CrowdSource owns cases, reviews and decisions;
Oxy Trust owns reputation; Moovo owns only its own enforcement actions.**
Everything lives in `packages/backend/src/services/moderation/`, over four models
(`report`, `moderation-outbox`, `moderation-event`, `moderation-enforcement`) and
two routes.

**What is reportable.** The live courier domain is delivered: `courier` and
`customer` (both `identity.profile`) and `delivery` (`custom.moovo.delivery`).
The inherited marketplace nouns (`listing`, `store`, `review`) are accepted by
`POST /reports` and stored, but have **no subject provider**, so they never
leave. Wiring a provider to a model scheduled for deletion buys nothing. The
registry decides DELIVERY, never admission: gating the route on it would break
existing report surfaces on adoption day.

**A delivery is not a `commerce.listing`.** A listing is an offer published to
anyone who looks; a delivery is a private movement of an object between two named
people. Forcing it into the commerce vocabulary tells a jury the wrong thing
about what it is reading. Allegation codes are mapped just as honestly:
`commerce.prohibited_item` genuinely fits, while "the courier drove dangerously"
has no universal code and becomes `other.policy_specific` rather than being bent
into `integrity.*`.

**`subjects/redaction.ts` is the load-bearing file. Read it before touching any
subject provider.** A `Job` carries two contact names, two phone numbers, two
street addresses, two precise coordinate pairs,
`proofOfDelivery.recipientName`, `payment.reference` and the pickup/dropoff
verification codes. None of it reaches a jury; the codes are a CREDENTIAL, not
evidence (the dropoff code is what proves a recipient is the intended one).
Coordinates are **dropped, not coarsened**: the contract would accept two
decimals, but two 1.1 km squares plus a timestamp narrow a household further than
either alone. Geography travels as ONE derived scalar instead, `distanceKm`,
rounded, which answers "did the courier take a detour" and identifies nothing
because a distance is translation invariant.

**`DELIVERY_FACT_KEYS` in `subjects/delivery-context.ts` is THE list of what a
delivery may emit, and the test compares it as an EXACT SET.** That direction is
the point: a list of "must not contain X" assertions only fails when a named
field goes missing, and is silent about a field ADDED, which is how every real
leak arrives (somebody passes an object through and a `contactPhone` rides
along). An exact comparison catches fields nobody has thought to forbid yet.
**When it fails after you added a field, the fix is not to append the key.**
Decide whether an anonymous stranger reviewing a case may see it, and only then
write it down.

**A conduct report names an account but is about an ENCOUNTER.** `contextJobId`
attaches the delivery as context so a jury can answer "was this courier abusive",
which a profile alone cannot support. `ReportIntakeService` verifies server side
that the reporter was the sender or the assigned courier on that job; without
that check any user could attach any job id and have Moovo package a stranger's
delivery into a case. It fails silently (context dropped, report still stored) so
a prober cannot learn which job ids exist.

**Moovo has exactly ONE enforcement lever**, `CourierProfile.status`, and this
integration is its first writer. There is deliberately no `restrict_delivery`: a
collected parcel cannot be un-collected, and cancelling a job mid transit strands
a courier holding somebody's property, so a decision about a delivery becomes
`manual_review`. There is no customer-side lever at all. `suspend_user` is
carried out as `suspend_courier` (privileges only, never the Oxy account) and
recorded under that narrower name. `no_violation` ALWAYS plans a
`reinstate_courier` even when the recommendation is `no_action`, because
otherwise a successful appeal leaves a courier suspended forever with no error
anywhere.

**Two invariants that fail silently if broken:**

- `enqueueModerationOutboxRow` **refuses the root connection**, via
  `requireTransaction` in `db/transactionGuard.ts`. The report and its delivery
  event commit together or not at all; `DatabaseOrTransaction` is a union the
  root handle satisfies, so a caller that forgets to pass `tx` type-checks,
  commits the row alone, and passes any test that only asserts the row exists.
  The discriminator is that only a transaction handle carries `.rollback`,
  which is why the guard is a function rather than a signature.
- The webhook router **must stay mounted before `express.json()`** in
  `index.ts`. The signature covers the bytes that arrived. Guarded by a test
  asserting `typeof req.body === 'undefined'` inside the route, plus one pinning
  the ordering in `index.ts` itself.

**The moderation writes are tested against a REAL PostgreSQL server**
(`services/moderation/__tests__/moderation.realdb.test.ts`), and that is not belt
and braces: **a mocked repository accepts every statement, including ones the
server rejects.** An update naming `updatedAt` under two operators once passed a
fully green mocked suite and failed every real write; that blind spot is
engine-independent. Any
new moderation write belongs in the `.realdb.test.ts` file, not in a mocked one.

**The outbox enqueue is `ON CONFLICT (id) DO NOTHING`, and a repeat writes
NOTHING — no tuple version, no timestamp, no lock.** Not because a flag was
passed but because there is no update branch to write one. That matters because a
repeat enqueue is ordinary (a transaction retry, two concurrent duplicate
submissions, a reconciliation sweep re-deriving an event) while the dispatcher is
concurrently claiming and renewing leases on those same rows. It is pinned on
`xmin` as well as `updated_at`: a careful `DO UPDATE` setting every column to its
current value would leave `updated_at` alone — `$onUpdate` only fires on a real
change — and still bump the tuple, so `updated_at` alone cannot tell "wrote
nothing" from "wrote the same thing".

**Neither claim-by-unique may RAISE.** The webhook dedupe claim and the
enforcement claim both used to insert and catch a duplicate-key error. In
Postgres a raised `23505` aborts the surrounding transaction, so every later
statement fails with `25P02` — and both run inside one, where a decision plans
SEVERAL actions and one already-claimed action must not abandon the others.
`ON CONFLICT DO NOTHING RETURNING` makes the empty result the answer instead.
The realdb suite asserts the transaction is still USABLE afterwards, because
answering `false` is not on its own evidence that nothing was poisoned.

**The three lease transitions do NOT share count semantics.** `renew` reads a
MATCH count deliberately: two renewals inside one millisecond compute an
identical `leaseUntil`, so a renewal that held its lease perfectly modifies
nothing, and re-spelling it as "did something change" reports a LOST lease that
was never lost — which the dispatcher answers by abandoning delivery mid-flight.
Postgres has one number and it behaves like `matchedCount`, so `renew` ports
exactly; `complete` and `fail` coincide with it only because they always move
`status` off `processing`, which is an ARGUMENT rather than a construction. A
test comparing two numbers cannot check that argument, so each transition is
called TWICE and the second call is asserted on `updated_at` and `xmin`.

**`reports.decision_revision` is what refuses a late, EARLIER revision.**
Without it every late delivery of an earlier revision would be applied — a
retried suspension could overwrite an accepted appeal's `dismissed` with
`resolved`, and the report would say the courier was found in violation of
something they had been cleared of. Both directions are pinned in the realdb
suite.

**Moovo holds no CrowdSource key and no Oxy service key.** The client is
`crowdSourceForOxyService()` from `@crowdsource.you/core`, which presents the Oxy
service token minted through its registered temporary role identity (oxy ADR 0049);
CrowdSource resolves the tenant from the Oxy application that token names. The
wrapper the three sibling apps each carried is that one call now — anything
genuinely Moovo's lives where it is acted on, not at the client.

**Env:** `CROWDSOURCE_ENABLED` (requires the webhook secret to take effect),
`CROWDSOURCE_BASE_URL`, `CROWDSOURCE_WEBHOOK_SECRET`,
`CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`, `CROWDSOURCE_OUTBOX_BATCH_SIZE`,
`CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS`, `CROWDSOURCE_ENFORCEMENT_MODE` (default
`observe`). **There is no `CROWDSOURCE_SERVICE_KEY` any more and there is no
`CROWDSOURCE_APP_ID` — never add either**: the tenant follows the token, a
variable holding one could only ever disagree with it, and a surface able to
carry an `applicationId` is the cross-tenant write the tenancy model exists to
prevent.

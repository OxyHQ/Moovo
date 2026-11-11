<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Open decisions the Postgres port left, with owners

Two things the port could not decide for itself. Both are recorded here rather
than in a PR body, because a PR body is the one place a statement reliably goes
unread once the PR is merged.

### `job_location_pings` grows without bound, and nothing sweeps it — OWNER: the courier-product decision

`JOB_MAX_LOCATION_PINGS` caps the trail on the READ, not the WRITE: a row has
no size limit, so nothing is trimmed at insert. `hydrateJob` returns the most
recent N ascending, with nothing destroyed to produce it
(`listRecentLocationPings`).

That is right for the DTO and leaves the table unbounded. Rough size: a 30-minute
delivery pinging every 10s is ~180 rows, so ~180k rows a day at a thousand
deliveries — real growth, on a table nothing reaps.

**It is deliberately NOT registered in `db/expiry.ts` yet, and that is the
decision being recorded, not an omission.** Registering it requires a retention
in seconds, and no defensible number is derivable from this repo: the only
consumer is the sender's own view of their own job, and the number that matters
is how long a courier's route must stay reconstructible for a DISPUTE. Inventing
one silently deletes a customer's evidence at whatever interval somebody guessed.

Closing it is one entry in `EXPIRY_TARGETS` keyed on `job_location_pings.at`
plus a leading btree on that column — the shape `quotes`/`job_offers` already
use. **Whoever sets the dispute window owns this.** Until then the growth is
known and accepted, which is a different thing from unnoticed.

### `START WITH 1` on both sequences must be RE-CONFIRMED at cutover — OWNER: the cutover run

`order_number_seq` and `job_number_seq` start at 1, and that is correct ONLY
because the pre-port census found `counters` empty, with no document for `order`
and none for `job`. That fact was true when it was measured and is exactly the
kind that stops being true quietly.

**Re-run the census (`oxy-moovo-census:1`) against the live database immediately
before the cutover.** A sequence left at 1 against a populated table re-issues
`MRC-000001` and collides with the unique index **at a customer's checkout** —
loud, and at the worst possible moment. If the census finds rows, the sequences
must be set past the highest existing number in the same window, before any
traffic.

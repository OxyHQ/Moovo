/**
 * What a jury may see of a delivery, and what it may never see.
 *
 * This module has no equivalent in a social app's integration, and it is the
 * substance of Moovo's. A Mention post is material its author published; a Moovo
 * delivery is a private transaction between two people at two street addresses,
 * and a reviewer drawn at random from the community is a STRANGER to both. §9.1
 * keeps a reviewer's view to the minimum that makes the question answerable, and
 * §13.5 requires precise location to be redacted before community review — so the
 * question here is not "how do we serialise a Job" but "what is the least that
 * still lets someone answer 'was this courier abusive'".
 *
 * ## The list of things that must never travel
 *
 * Every one of these is present on the Job document and would serialise happily:
 *
 * - **`contactName` / `contactPhone`** on both endpoints. A phone number is the
 *   single most abusable field in the document: a case is reviewed by strangers,
 *   and handing them a name and a mobile number turns a moderation report into a
 *   harassment vector pointed at the person who was reported ABOUT rather than
 *   the person reported.
 * - **`address.line1` / `line2` / `postalCode`.** A street address is where
 *   somebody lives. `city`/`region`/`country` survive as a coarse label because
 *   jurisdiction is occasionally the question (a prohibited item is prohibited
 *   somewhere in particular); the door number never is.
 * - **Precise `coordinates`.** Not sent at ALL, coarsened or otherwise — see
 *   {@link coarseLocationLabel}.
 * - **`pickupCode` / `dropoffCode` / `pickupCodeHash` / `dropoffCodeHash`.** These
 *   are the delivery verification secrets. The plaintext codes are surfaced ONLY
 *   to the sender precisely so they can relay the dropoff code to the recipient,
 *   and a courier scans against the hash. Putting either in front of a jury hands
 *   a stranger the token that proves a delivery was collected — this is a
 *   credential, not evidence, and no allegation is ever answered by it.
 * - **`proofOfDelivery.recipientName`.** Frequently a third party who is neither
 *   the reporter nor the reported and never consented to anything.
 * - **`payment.reference`.** A payment-provider handle, and no jury question turns
 *   on it.
 *
 * ## Why coordinates are dropped rather than coarsened
 *
 * The contract will accept a coordinate rounded to two decimals (~1.1 km) and
 * REFUSES a precise one outright — `LocationResourceSchema` validates the
 * precision of the number itself rather than trusting a downstream renderer. So
 * coarsening would be legal. It is still the wrong call here: a delivery has TWO
 * endpoints, and a pair of 1.1 km squares plus a timestamp and a parcel
 * description narrows a household far more than either square does alone. A city
 * label answers every jurisdiction question a jury actually has, so the
 * coordinates buy nothing that justifies the residual risk.
 *
 * That also means the coarseness rule can never be violated by this code, because
 * no coordinate is ever constructed — which is a stronger guarantee than rounding
 * correctly.
 */

/**
 * The MOST a place may be described as, on the way in.
 *
 * Deliberately not `ShipmentAddressValue` and deliberately not derived from it.
 * The return types below already refuse to emit a street; this refuses to
 * ACCEPT one, so the moderation path has no type through which `line1` or a
 * postcode could arrive in the first place — and `findJobModerationFacts` never
 * selects those columns, so nothing loads them either. Two independent walls,
 * where the source had one.
 *
 * A new endpoint field is therefore invisible here until somebody widens this
 * interface on purpose, which is the same argument {@link RedactedEndpoint}
 * makes about the way out.
 */
export interface CoarsePlace {
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  /** The user's own delivery instructions. */
  readonly notes?: string;
}

/** §5.3 claims and labels are bounded, flat and scalar. */
const MAX_LABEL_LENGTH = 200;
/** Free text a user wrote. Bounded so one delivery cannot dominate a case. */
const MAX_NOTE_LENGTH = 1_000;

/**
 * Trim, bound, and treat blank as absent.
 *
 * Absent rather than empty matters: the contract rejects an empty text resource,
 * and `''` would otherwise travel as though the user had written something.
 */
export function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/** A user-authored note, bounded. */
export function note(value: string | undefined): string | undefined {
  return boundedText(value, MAX_NOTE_LENGTH);
}

/**
 * An address as a place, not as a destination.
 *
 * `city`, `region` and `country` only — never `line1`, `line2` or `postalCode`. A
 * postal code is deliberately excluded even though it feels coarse: in much of
 * Europe a full postcode covers a single street and in the UK a handful of
 * houses, so it is a street address wearing a different shape.
 *
 * Returns `undefined` when there is nothing safe to say, which is a normal
 * outcome and not an error.
 */
export function coarseLocationLabel(place: CoarsePlace | undefined): string | undefined {
  if (!place) return undefined;
  const parts = [place.city, place.region, place.country]
    .map((part) => boundedText(part, MAX_LABEL_LENGTH))
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  // Deduplicated: a city-state repeats itself ("Singapore, Singapore, SG") and a
  // jury reading a doubled label learns nothing from the second copy.
  return Array.from(new Set(parts)).join(', ');
}

/**
 * One endpoint of a delivery, reduced to what a stranger may see.
 *
 * The return type is deliberately NOT derived from the persisted endpoint. A
 * structural `Omit` would silently start passing any field added to the endpoint
 * later — a `recipientEmail`, a `buzzerCode`, an `accessInstructions` — and the
 * failure mode of that is a PII leak that no test knows to look for. Listing the
 * two safe fields explicitly means a new endpoint field is invisible here until
 * somebody decides it is safe.
 */
export interface RedactedEndpoint {
  /** City, region and country. Never a street, a number or a postcode. */
  readonly locationLabel?: string;
  /** The user's own delivery instructions, which is material a jury may need. */
  readonly notes?: string;
}

export function redactEndpoint(place: CoarsePlace | undefined): RedactedEndpoint {
  if (!place) return {};
  const locationLabel = coarseLocationLabel(place);
  const endpointNotes = note(place.notes);
  return {
    ...(locationLabel === undefined ? {} : { locationLabel }),
    ...(endpointNotes === undefined ? {} : { notes: endpointNotes }),
  };
}

/**
 * What an ANONYMOUS lookup is allowed to say.
 *
 * `POST /tracking/lookup` is an enumeration surface by design — anyone can
 * probe numbers, exactly as the carrier's own website lets them. That is
 * answered with a hard per-IP rate limit. What it must NEVER answer with is the
 * personal data a carrier will happily hand us: the recipient's name, the
 * delivery address, a signature image, a phone number.
 *
 * ## Why this is an ALLOW-list compared as an exact set
 *
 * The same argument as `DELIVERY_FACT_KEYS` in the moderation domain, and it is
 * worth restating because the wrong shape looks equally careful:
 *
 * A set of "must not contain `recipientName`" assertions only fails when a
 * field somebody NAMED disappears. It is completely silent about a field
 * somebody ADDS — and that is how every real leak arrives. Nobody sits down to
 * expose a recipient's name; somebody passes a carrier response object through
 * a new mapper and a `deliveredTo` rides along.
 *
 * So the permitted keys are written down, the test compares the built object's
 * keys as an EXACT SET, and adding a field to the public shape means changing
 * this list on purpose. **When that test fails after you added a field, the fix
 * is not to append the key.** Decide first whether an anonymous stranger
 * holding only a tracking number may see it.
 */

/** Every key a public lookup response may carry, at the top level. */
export const PUBLIC_PARCEL_FACT_KEYS = [
  'carrier',
  'trackingNumber',
  'status',
  'estimatedDeliveryAt',
  'deliveredAt',
  'lastCheckpointAt',
  'trackingUrl',
  'checkpoints',
] as const;

/**
 * Every key a checkpoint inside a public response may carry.
 *
 * `locationText` is here and it is the one worth pausing on: it is the carrier's
 * own depot or city label ("MADRID - CENTRO LOGISTICO"), which is where the
 * PARCEL was, not where the recipient lives. A carrier that puts a street
 * address in that field would leak through this — which is why the mapper
 * truncates it and why `description` is passed through the same bound.
 */
export const PUBLIC_CHECKPOINT_FACT_KEYS = [
  'id',
  'status',
  'rawStatus',
  'description',
  'locationText',
  'countryCode',
  'occurredAt',
  'occurredAtIsLocal',
] as const;

/**
 * Deliberately absent, recorded so the omissions read as decisions.
 *
 * Not consumed by any code — this is documentation the exact-set test makes
 * enforceable, because anything not in the allow-lists above cannot appear
 * whether or not it is named here.
 */
export const PUBLIC_PARCEL_REFUSED_FACTS = [
  'recipientName',
  'recipientAddress',
  'recipientPhone',
  'signatureImage',
  'signedBy',
  'senderName',
  'coordinates',
] as const;

/**
 * The tracker's write path and its reads.
 *
 * ## Subscribing is the only thing that arms the poller
 *
 * An anonymous lookup creates or refreshes the shared parcel row — that IS the
 * cache, and it is where the deduplication pays — but leaves it with no
 * subscribers and therefore no due time. It costs exactly one carrier call and
 * is reaped in thirty days. `trackParcel` is what gives a parcel a
 * `nextPollAt`, and `untrackParcel` takes it away again when the last watcher
 * leaves.
 *
 * ## Creating a parcel and subscribing to it commit together
 *
 * Both writes happen inside one `db.transaction`, and neither may raise on a
 * conflict: two people adding the same number at the same instant both miss and
 * both insert, and a `23505` would abort the transaction rather than answer the
 * question. Both repositories use `ON CONFLICT DO NOTHING RETURNING` for that
 * reason.
 */

import { getDb } from '../../db/postgres.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { findJobWithHistory } from '../../db/transport/jobRepository.js';
import { hydrateJobs } from '../job-hydration.service.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { MOOVO_CARRIER_KEY } from './job-pointer.service.js';
import {
  findOrCreateParcel,
  findParcelById,
  refreshSubscriberCount,
} from '../../db/tracking/trackedParcelRepository.js';
import {
  deleteSubscription,
  findSubscriptionForUser,
  listSubscriptionsForUser,
  subscribeIfAbsent,
  updateSubscription,
} from '../../db/tracking/trackedParcelSubscriptionRepository.js';
import { listCheckpoints } from '../../db/tracking/trackingCheckpointRepository.js';
import {
  findTrackingCarrierByKey,
  findTrackingCarriersByKeys,
  listEnabledTrackingCarriers,
  type TrackingCarrierRow,
} from '../../db/tracking/trackingCarrierRepository.js';
import { detectCarriers, normalizeTrackingNumber, resolveDetection } from './carrier-detection.js';
import { nextPollAt } from './tracking-cadence.js';
import {
  toCarrierSummary,
  toCheckpoint,
  toPublicLookup,
  toTrackedParcel,
} from './tracking-hydration.service.js';
import type {
  CarrierGuess,
  FiatCurrency,
  PublicParcelLookup,
  TrackedParcel,
  TrackedParcelDetail,
  TrackingCarrierSummary,
  TrackingStatus,
} from '@moovo/shared-types';

/** How recently a parcel must have been polled for a manual refresh to be refused. */
const REFRESH_COOLDOWN_MS = 60_000;

async function requireCarrier(carrierKey: string): Promise<TrackingCarrierRow> {
  const carrier = await findTrackingCarrierByKey(carrierKey);
  if (!carrier || !carrier.enabled) {
    throw notFound(`Unknown or disabled carrier: ${carrierKey}`);
  }
  return carrier;
}

/**
 * The same, for a carrier key that came from a CALLER.
 *
 * `moovo` is the internal pointer key. Those rows carry a `moovoJobId` and zero
 * checkpoints for their whole life, and `getParcelDetail` hydrates the JOB
 * instead — so a row created on that key with no job behind it is a parcel the
 * detail endpoint can never hydrate, falling through to an empty carrier
 * timeline forever. A Moovo parcel is created by BOOKING, never by pasting.
 *
 * This is separate from {@link requireCarrier} rather than a check inside it,
 * and the split is the whole point: reading an EXISTING pointer must keep
 * working. `updateParcel` and `toTrackedParcel` resolve the carrier of a row
 * that is already `moovo`, and a blanket ban inside `requireCarrier` would break
 * every Moovo delivery in every customer's list.
 *
 * The app also filters `moovo` out of its picker, but a filter in a client is
 * not a rule — `POST /tracking/lookup` is public and unauthenticated.
 */
async function requireSelectableCarrier(carrierKey: string): Promise<TrackingCarrierRow> {
  if (carrierKey === MOOVO_CARRIER_KEY) {
    throw validationError('That is not a carrier you can select.');
  }
  return await requireCarrier(carrierKey);
}

/**
 * The catalogue, for the picker.
 *
 * `moovo` is excluded for the same reason {@link requireSelectableCarrier}
 * refuses it: it is an internal pointer key, not something a person picks. A
 * catalogue that lists a key the API then rejects is a worse contract than one
 * that never offers it.
 */
export async function listCarriers(): Promise<TrackingCarrierSummary[]> {
  return (await listEnabledTrackingCarriers())
    .filter((carrier) => carrier.key !== MOOVO_CARRIER_KEY)
    .map(toCarrierSummary);
}

/**
 * Which carriers a number might belong to, ranked.
 *
 * Country codes come from the rows rather than from the adapters so an operator
 * can retune the ranking without a deploy.
 */
export async function detectCarriersForNumber(
  number: string,
  destinationCountry?: string,
): Promise<{ carrierKey: string | null; candidates: CarrierGuess[] }> {
  const carriers = await listEnabledTrackingCarriers();
  const byKey = new Map(carriers.map((carrier) => [carrier.key, carrier]));
  const carrierCountries = Object.fromEntries(
    carriers.map((carrier) => [carrier.key, carrier.countryCodes]),
  );

  const detected = detectCarriers(number, { country: destinationCountry, carrierCountries });
  // A carrier an operator has disabled must not be offered, however well it
  // matched: `enabled` is the switch somebody flips when a carrier's feed is
  // misbehaving, and it has to take effect everywhere.
  const enabled = detected.filter((candidate) => byKey.has(candidate.carrierKey));
  const resolved = resolveDetection(enabled);

  return {
    carrierKey: resolved.carrierKey,
    candidates: resolved.candidates.map((candidate) => ({
      carrierKey: candidate.carrierKey,
      name: byKey.get(candidate.carrierKey)?.name ?? candidate.carrierKey,
      checksumPassed: candidate.checksumPassed,
      score: candidate.score,
    })),
  };
}

/** Detection, or a validation error naming the alternatives. */
async function resolveCarrierOrThrow(
  number: string,
  carrierKey: string | undefined,
  destinationCountry: string | undefined,
): Promise<TrackingCarrierRow> {
  if (carrierKey) return await requireSelectableCarrier(carrierKey);

  const detected = await detectCarriersForNumber(number, destinationCountry);
  if (!detected.carrierKey) {
    throw validationError(
      detected.candidates.length === 0
        ? 'We could not tell which carrier this number belongs to. Pick one.'
        : 'This number could belong to more than one carrier. Pick one.',
    );
  }
  return await requireCarrier(detected.carrierKey);
}

export interface TrackParcelInput {
  number: string;
  carrierKey?: string;
  title?: string;
  destinationPostalCode?: string;
  destinationCountry?: string;
  notify?: boolean;
}

/**
 * Add a parcel to one user's list, creating the shared identity if this is the
 * first person to ask about it.
 */
export async function trackParcel(
  oxyUserId: string,
  input: TrackParcelInput,
): Promise<TrackedParcel> {
  const normalised = normalizeTrackingNumber(input.number);
  if (normalised.length < 4) {
    throw validationError('That does not look like a tracking number.');
  }

  const carrier = await resolveCarrierOrThrow(
    normalised,
    input.carrierKey,
    input.destinationCountry,
  );

  const result = await getDb().transaction(async (tx) => {
    const { parcel } = await findOrCreateParcel(
      {
        carrierKey: carrier.key,
        trackingNumber: normalised,
        destinationPostalCode: input.destinationPostalCode,
        destinationCountry: input.destinationCountry,
        // A carrier we cannot call is never scheduled. The CHECK enforces the
        // same thing; this is what keeps the insert from tripping it.
        pollMode: carrier.pollSupported ? 'poll' : 'deeplink',
      },
      tx,
    );

    const { subscription } = await subscribeIfAbsent(
      {
        parcelId: parcel.id,
        oxyUserId,
        enteredNumber: input.number,
        title: input.title ?? null,
        notifyOnStateChange: input.notify ?? true,
      },
      tx,
    );

    // Arm the poller. Counting rather than incrementing, because the counter is
    // advisory and a count cannot drift.
    const due = carrier.pollSupported
      ? nextPollAt({
          status: parcel.status as TrackingStatus,
          pollMode: parcel.pollMode as 'poll' | 'webhook' | 'deeplink' | 'manual',
          subscriberCount: 1,
          lastCheckpointAt: parcel.lastCheckpointAt,
          now: new Date(),
        })
      : null;
    await refreshSubscriberCount(parcel.id, due, tx);

    const refreshed = await findParcelById(parcel.id, tx);
    return { subscription, parcel: refreshed ?? parcel };
  });

  return toTrackedParcel({ ...result, carrier });
}

/**
 * The ANONYMOUS lookup: one question, one answer, nothing kept per person.
 *
 * It still writes the shared parcel row, because that row is the cache every
 * later watcher shares — but with no subscriber it is born with no due time and
 * is never fetched again on its own.
 */
export async function lookupParcel(input: {
  number: string;
  carrierKey?: string;
  destinationPostalCode?: string;
}): Promise<PublicParcelLookup> {
  const normalised = normalizeTrackingNumber(input.number);
  if (normalised.length < 4) {
    throw validationError('That does not look like a tracking number.');
  }

  const carrier = await resolveCarrierOrThrow(normalised, input.carrierKey, undefined);

  const { parcel } = await findOrCreateParcel({
    carrierKey: carrier.key,
    trackingNumber: normalised,
    destinationPostalCode: input.destinationPostalCode,
    pollMode: carrier.pollSupported ? 'poll' : 'deeplink',
  });

  const checkpoints = await listCheckpoints(parcel.id);
  return toPublicLookup({ parcel, carrier, checkpoints });
}

/** One user's list. */
export async function listParcels(
  oxyUserId: string,
  options: { limit: number; offset: number; includeArchived?: boolean },
): Promise<TrackedParcel[]> {
  const subscriptions = await listSubscriptionsForUser(oxyUserId, options);
  if (subscriptions.length === 0) return [];

  const parcels = await Promise.all(
    subscriptions.map((subscription) => findParcelById(subscription.parcelId)),
  );
  const carriers = await findTrackingCarriersByKeys([
    ...new Set(parcels.flatMap((parcel) => (parcel ? [parcel.carrierKey] : []))),
  ]);
  const carriersByKey = new Map(carriers.map((carrier) => [carrier.key, carrier]));

  const views: TrackedParcel[] = [];
  for (const [index, subscription] of subscriptions.entries()) {
    const parcel = parcels[index];
    const carrier = parcel ? carriersByKey.get(parcel.carrierKey) : undefined;
    // A parcel or carrier that vanished under a live subscription is a broken
    // invariant, not a row to render half of. Skipping keeps the list usable
    // and leaves the inconsistency for the reconciliation pass to report.
    if (!parcel || !carrier) continue;
    views.push(toTrackedParcel({ subscription, parcel, carrier }));
  }
  return views;
}

/**
 * One parcel, scoped to its owner. A miss is a 404, never a 403.
 *
 * Branches on `moovoJobId`, which is what makes the pointer design pay: one of
 * our own deliveries is hydrated from the JOB — live map, courier, proof of
 * delivery, its real timeline — rather than from `tracking_checkpoints`, which
 * for such a parcel is empty by design and stays that way.
 */
export async function getParcelDetail(
  subscriptionId: string,
  oxyUserId: string,
  displayCurrency: FiatCurrency = 'EUR',
): Promise<TrackedParcelDetail> {
  const subscription = await findSubscriptionForUser(subscriptionId, oxyUserId);
  if (!subscription) throw notFound('Parcel not found');

  const parcel = await findParcelById(subscription.parcelId);
  if (!parcel) throw notFound('Parcel not found');
  const carrier = await requireCarrier(parcel.carrierKey);
  const view = toTrackedParcel({ subscription, parcel, carrier });

  if (parcel.moovoJobId) {
    const job = await findJobWithHistory(parcel.moovoJobId, config.jobs.maxLocationPings);
    if (job) {
      // `includeCodes` stays FALSE. The pickup and dropoff codes are a
      // CREDENTIAL — the dropoff code is what proves a recipient is the
      // intended one — and the tracker is a read surface, not the sender's
      // handover screen.
      const [hydrated] = await hydrateJobs([job], displayCurrency, { includeCodes: false });
      if (hydrated) {
        return { source: 'moovo_job', parcel: view, job: hydrated, checkpoints: [] };
      }
    }
    // The job vanished under its own pointer. Falling through to the empty
    // carrier timeline is honest — the parcel is still listed and still
    // readable — and the inconsistency is left for reconciliation rather than
    // turned into a 500 on somebody's delivery.
    log.general.warn(
      { parcelId: parcel.id, jobId: parcel.moovoJobId },
      '[Tracking] job pointer resolves to no job',
    );
  }

  const checkpoints = await listCheckpoints(parcel.id);
  return {
    source: 'carrier',
    parcel: view,
    checkpoints: checkpoints.map(toCheckpoint),
  };
}

export interface UpdateParcelPatch {
  title?: string;
  notify?: boolean;
  archived?: boolean;
  carrierKey?: string;
}

/**
 * Change a subscription, including correcting a wrong carrier.
 *
 * A carrier correction RE-POINTS the subscription at the right identity. It
 * must never rewrite `tracked_parcels.carrier_key`: that column is half of the
 * key the unique index expresses, so mutating it either collides with the
 * carrier's real row or silently rewrites a parcel other people are watching.
 */
export async function updateParcel(
  subscriptionId: string,
  oxyUserId: string,
  patch: UpdateParcelPatch,
): Promise<TrackedParcel> {
  const subscription = await findSubscriptionForUser(subscriptionId, oxyUserId);
  if (!subscription) throw notFound('Parcel not found');

  const current = await findParcelById(subscription.parcelId);
  if (!current) throw notFound('Parcel not found');

  if (patch.carrierKey && patch.carrierKey !== current.carrierKey) {
    return await repointSubscription(subscription.id, oxyUserId, current, patch);
  }

  const updated = await updateSubscription(subscription.id, oxyUserId, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.notify !== undefined ? { notifyOnStateChange: patch.notify } : {}),
    ...(patch.archived !== undefined ? { archivedAt: patch.archived ? new Date() : null } : {}),
  });
  if (!updated) throw notFound('Parcel not found');

  const carrier = await requireCarrier(current.carrierKey);
  return toTrackedParcel({ subscription: updated, parcel: current, carrier });
}

async function repointSubscription(
  subscriptionId: string,
  oxyUserId: string,
  currentParcel: { id: string; trackingNumber: string },
  patch: UpdateParcelPatch,
): Promise<TrackedParcel> {
  const carrier = await requireSelectableCarrier(patch.carrierKey!);

  const result = await getDb().transaction(async (tx) => {
    const previous = await findSubscriptionForUser(subscriptionId, oxyUserId, tx);
    if (!previous) throw notFound('Parcel not found');

    const { parcel } = await findOrCreateParcel(
      {
        carrierKey: carrier.key,
        trackingNumber: currentParcel.trackingNumber,
        pollMode: carrier.pollSupported ? 'poll' : 'deeplink',
      },
      tx,
    );

    await deleteSubscription(subscriptionId, oxyUserId, tx);
    const { subscription } = await subscribeIfAbsent(
      {
        parcelId: parcel.id,
        oxyUserId,
        enteredNumber: previous.enteredNumber,
        title: patch.title ?? previous.title,
        notifyOnStateChange: patch.notify ?? previous.notifyOnStateChange,
      },
      tx,
    );

    // Both sides: the parcel that gained a watcher is armed, the one that lost
    // its last is disarmed.
    const due = carrier.pollSupported
      ? nextPollAt({
          status: parcel.status as TrackingStatus,
          pollMode: parcel.pollMode as 'poll' | 'webhook' | 'deeplink' | 'manual',
          subscriberCount: 1,
          lastCheckpointAt: parcel.lastCheckpointAt,
          now: new Date(),
        })
      : null;
    await refreshSubscriberCount(parcel.id, due, tx);
    await refreshSubscriberCount(currentParcel.id, null, tx);

    const refreshed = await findParcelById(parcel.id, tx);
    return { subscription, parcel: refreshed ?? parcel };
  });

  return toTrackedParcel({ ...result, carrier });
}

/** Stop watching. The parcel row survives as a shared cache; it just stops costing. */
export async function untrackParcel(subscriptionId: string, oxyUserId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const parcelId = await deleteSubscription(subscriptionId, oxyUserId, tx);
    if (!parcelId) throw notFound('Parcel not found');
    // Recount, and disarm if that was the last watcher. Passing `null` is safe
    // even when others remain: the poller re-arms on its next successful fetch,
    // and the reconciliation pass catches a parcel left unscheduled.
    const remaining = await refreshSubscriberCount(parcelId, null, tx);
    if (remaining > 0) {
      const parcel = await findParcelById(parcelId, tx);
      if (parcel) {
        const due = nextPollAt({
          status: parcel.status as TrackingStatus,
          pollMode: parcel.pollMode as 'poll' | 'webhook' | 'deeplink' | 'manual',
          subscriberCount: remaining,
          lastCheckpointAt: parcel.lastCheckpointAt,
          now: new Date(),
        });
        await refreshSubscriberCount(parcelId, due, tx);
      }
    }
  });
}

/**
 * Ask for a parcel to be fetched now.
 *
 * Sets the due time and returns; it never calls the carrier inline, because a
 * request thread must not hold a carrier's timeout open. Refused inside a short
 * cooldown so the button cannot be used to spend the carrier budget.
 */
export async function requestRefresh(subscriptionId: string, oxyUserId: string): Promise<void> {
  const subscription = await findSubscriptionForUser(subscriptionId, oxyUserId);
  if (!subscription) throw notFound('Parcel not found');

  const parcel = await findParcelById(subscription.parcelId);
  if (!parcel) throw notFound('Parcel not found');

  const carrier = await requireCarrier(parcel.carrierKey);
  if (!carrier.pollSupported) {
    throw conflict(`${carrier.name} does not publish a feed we can read.`);
  }
  if (
    parcel.lastPolledAt &&
    Date.now() - parcel.lastPolledAt.getTime() < REFRESH_COOLDOWN_MS
  ) {
    throw conflict('This parcel was checked moments ago. Try again shortly.');
  }

  await refreshSubscriberCount(parcel.id, new Date());
}

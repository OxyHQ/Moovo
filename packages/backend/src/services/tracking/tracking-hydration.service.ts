/**
 * Rows to DTOs.
 *
 * Two shapes, and the difference between them is the point: {@link toTrackedParcel}
 * is what an authenticated owner sees (their own title, their notification
 * preference, the subscription's id), while {@link toPublicLookup} is what a
 * stranger holding only a number sees. The second is built from an ALLOW-LIST —
 * see `public-facts.ts` for why that direction rather than a set of omissions.
 *
 * The id a client ever sees for a parcel is the SUBSCRIPTION's, never
 * `tracked_parcels.id`. That row is shared by everyone tracking the number, so
 * exposing its id would let anyone who learned one read a parcel they never
 * added, and would make `DELETE` ambiguous.
 */

import type {
  PublicParcelLookup,
  TrackedParcel,
  TrackingCarrierSummary,
  TrackingCheckpoint,
  TrackingStatus,
} from '@moovo/shared-types';
import type { TrackedParcelRow } from '../../db/tracking/trackedParcelRepository.js';
import type { TrackedParcelSubscriptionRow } from '../../db/tracking/trackedParcelSubscriptionRepository.js';
import type { TrackingCheckpointRow } from '../../db/tracking/trackingCheckpointRepository.js';
import type { TrackingCarrierRow } from '../../db/tracking/trackingCarrierRepository.js';

/** The carrier's own tracking page for this number. */
export function buildTrackingUrl(carrier: TrackingCarrierRow, trackingNumber: string): string {
  return carrier.deepLinkTemplate.replace('{number}', encodeURIComponent(trackingNumber));
}

export function toCarrierSummary(carrier: TrackingCarrierRow): TrackingCarrierSummary {
  return {
    key: carrier.key,
    name: carrier.name,
    ...(carrier.logoFileId ? { logoUrl: carrier.logoFileId } : {}),
    sourceKind: carrier.sourceKind as TrackingCarrierSummary['sourceKind'],
    pollSupported: carrier.pollSupported,
    countryCodes: carrier.countryCodes,
  };
}

export function toCheckpoint(row: TrackingCheckpointRow): TrackingCheckpoint {
  return {
    id: row.id,
    status: row.status as TrackingStatus,
    ...(row.rawStatus ? { rawStatus: row.rawStatus } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.locationText ? { locationText: row.locationText } : {}),
    ...(row.countryCode ? { countryCode: row.countryCode } : {}),
    ...(row.latitude !== null && row.longitude !== null
      ? { location: { type: 'Point' as const, coordinates: [row.longitude, row.latitude] } }
      : {}),
    occurredAt: row.occurredAt.toISOString(),
    occurredAtIsLocal: row.occurredAtIsLocal,
  };
}

export function toTrackedParcel(input: {
  subscription: TrackedParcelSubscriptionRow;
  parcel: TrackedParcelRow;
  carrier: TrackingCarrierRow;
}): TrackedParcel {
  const { subscription, parcel, carrier } = input;
  return {
    // The SUBSCRIPTION's id. See the header.
    id: subscription.id,
    carrier: toCarrierSummary(carrier),
    trackingNumber: parcel.trackingNumber,
    status: parcel.status as TrackingStatus,
    ...(parcel.rawStatus ? { rawStatus: parcel.rawStatus } : {}),
    ...(subscription.title ? { title: subscription.title } : {}),
    ...(parcel.serviceName ? { serviceName: parcel.serviceName } : {}),
    ...(parcel.originCountry ? { originCountry: parcel.originCountry } : {}),
    ...(parcel.destinationCountry ? { destinationCountry: parcel.destinationCountry } : {}),
    ...(parcel.estimatedDeliveryAt
      ? { estimatedDeliveryAt: parcel.estimatedDeliveryAt.toISOString() }
      : {}),
    ...(parcel.deliveredAt ? { deliveredAt: parcel.deliveredAt.toISOString() } : {}),
    ...(parcel.lastCheckpointAt
      ? { lastCheckpointAt: parcel.lastCheckpointAt.toISOString() }
      : {}),
    checkpointCount: parcel.checkpointCount,
    trackingUrl: buildTrackingUrl(carrier, parcel.trackingNumber),
    notifyOnStateChange: subscription.notifyOnStateChange,
    ...(subscription.archivedAt ? { archivedAt: subscription.archivedAt.toISOString() } : {}),
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}

/**
 * What a stranger holding only a number is told.
 *
 * Built field by field from the allow-list in `public-facts.ts` rather than by
 * spreading a row and deleting what should not be there. Deletion is the shape
 * that silently passes through whatever somebody adds next.
 */
export function toPublicLookup(input: {
  parcel: TrackedParcelRow;
  carrier: TrackingCarrierRow;
  checkpoints: readonly TrackingCheckpointRow[];
}): PublicParcelLookup {
  const { parcel, carrier, checkpoints } = input;
  return {
    carrier: toCarrierSummary(carrier),
    trackingNumber: parcel.trackingNumber,
    status: parcel.status as TrackingStatus,
    ...(parcel.estimatedDeliveryAt
      ? { estimatedDeliveryAt: parcel.estimatedDeliveryAt.toISOString() }
      : {}),
    ...(parcel.deliveredAt ? { deliveredAt: parcel.deliveredAt.toISOString() } : {}),
    ...(parcel.lastCheckpointAt
      ? { lastCheckpointAt: parcel.lastCheckpointAt.toISOString() }
      : {}),
    trackingUrl: buildTrackingUrl(carrier, parcel.trackingNumber),
    checkpoints: checkpoints.map((row) => {
      // Built by NAMING the permitted fields rather than by spreading the
      // internal checkpoint and deleting what should not be there. Deletion is
      // the shape that silently passes through whatever somebody adds next; in
      // particular a public checkpoint carries NO coordinates, because a depot's
      // name is where the parcel was while a coordinate pair plus a timestamp
      // narrows a household — and the last fix on a delivered parcel is a
      // doorstep.
      const checkpoint = toCheckpoint(row);
      return {
        id: checkpoint.id,
        status: checkpoint.status,
        ...(checkpoint.rawStatus ? { rawStatus: checkpoint.rawStatus } : {}),
        ...(checkpoint.description ? { description: checkpoint.description } : {}),
        ...(checkpoint.locationText ? { locationText: checkpoint.locationText } : {}),
        ...(checkpoint.countryCode ? { countryCode: checkpoint.countryCode } : {}),
        occurredAt: checkpoint.occurredAt,
        occurredAtIsLocal: checkpoint.occurredAtIsLocal,
      };
    }),
  };
}

/**
 * Geo helpers (PURE — no I/O).
 *
 * The great-circle distance between two GeoJSON points via the Haversine
 * formula. Used by the quote service to derive a shipment's pickup→dropoff
 * distance for distance-proportional pricing. Coordinates follow GeoJSON order
 * (`[lng, lat]`).
 */

/** Mean Earth radius, metres (WGS-84 authalic radius). */
const EARTH_RADIUS_M = 6_371_008.8;

/** Radians per degree. */
const RADIANS_PER_DEGREE = Math.PI / 180;

/** A GeoJSON `[lng, lat]` coordinate pair. */
export interface LngLat {
  /** Longitude, degrees. */
  lng: number;
  /** Latitude, degrees. */
  lat: number;
}

/** Convert degrees to radians. */
function toRadians(degrees: number): number {
  return degrees * RADIANS_PER_DEGREE;
}

/**
 * Great-circle distance in metres between two `[lng, lat]` points (Haversine).
 * Pure and symmetric; returns `0` for identical points.
 */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);
  const h =
    sinHalfDLat * sinHalfDLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

/**
 * Great-circle distance in metres between two GeoJSON `[lng, lat]` coordinate
 * arrays, rounded to whole metres. Throws on a malformed coordinate pair.
 */
export function distanceMetersBetween(
  from: readonly number[],
  to: readonly number[],
): number {
  if (from.length < 2 || to.length < 2) {
    throw new Error('Both coordinates must be [lng, lat] pairs');
  }
  const meters = haversineMeters(
    { lng: from[0], lat: from[1] },
    { lng: to[0], lat: to[1] },
  );
  return Math.round(meters);
}

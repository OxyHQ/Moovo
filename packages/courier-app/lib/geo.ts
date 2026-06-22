import type { GeoPoint } from "@moovo/shared-types";

/**
 * Geo helpers (PURE — no I/O).
 *
 * Great-circle distance + human formatting for the courier surface. Used to show
 * the pickup→dropoff leg distance on job cards and the offer card; the dispatch
 * offer itself carries a server-computed courier→pickup `distanceM`.
 */

/** Earth mean radius in metres (WGS-84 mean). */
const EARTH_RADIUS_M = 6_371_000;

/** Metres in one kilometre — the km/m display threshold. */
const METRES_PER_KM = 1000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle (haversine) distance between two GeoJSON points, in metres.
 * Coordinates are `[lng, lat]`.
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const [lng1, lat1] = a.coordinates;
  const [lng2, lat2] = b.coordinates;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Format a metre distance for display: `850 m` below 1 km, `2.4 km` above. Never
 * shows fractional metres.
 */
export function formatDistance(meters: number): string {
  if (meters < METRES_PER_KM) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / METRES_PER_KM).toFixed(1)} km`;
}

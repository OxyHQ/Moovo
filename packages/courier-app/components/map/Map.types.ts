/**
 * Shared prop contract for the platform-split job map.
 *
 * The web implementation (`Map.tsx`) renders with maplibre-gl over free OSM
 * raster tiles (no API key); the native implementation (`Map.native.tsx`) renders
 * with react-native-maps over the same OSM raster tiles via `UrlTile`. Both
 * consume THIS module only — neither platform imports the other's renderer, so
 * `react-native-maps` never leaks into the web bundle.
 *
 * Coordinates are GeoJSON `[lng, lat]` everywhere to match the backend.
 */

/** A `[lng, lat]` coordinate pair (GeoJSON order). */
export type LngLat = [number, number];

/** A labelled point rendered as a marker on the map. */
export interface MapMarker {
  /** Stable key for the marker. */
  id: string;
  /** `[lng, lat]` position. */
  coordinate: LngLat;
  /** Semantic role, used to pick the marker color. */
  kind: "pickup" | "dropoff" | "courier";
  /** Accessible label / title. */
  label: string;
}

/** Props accepted by both platform map implementations. */
export interface JobMapProps {
  /** Markers to render (pickup, dropoff, and optionally the live courier point). */
  markers: MapMarker[];
  /**
   * An ordered route polyline (`[lng, lat]` points). For v1 this is a straight
   * line through pickup → dropoff (and the courier point when known) — no routing
   * API is used. Omit or pass fewer than two points to draw no line.
   */
  route?: LngLat[];
  /** Optional className applied to the map container. */
  className?: string;
}

/** Marker fill colors by role (kept platform-agnostic). */
export const MARKER_COLORS: Record<MapMarker["kind"], string> = {
  pickup: "#16a34a",
  dropoff: "#dc2626",
  courier: "#2563eb",
};

/** The free OpenStreetMap raster tile template (no API key required). */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Required OSM attribution string. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/** Default zoom when fitting a single point. */
export const DEFAULT_ZOOM = 13;

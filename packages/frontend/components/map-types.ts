/**
 * Shared prop/type contract for the platform-split `Map` component.
 *
 * `Map.web.tsx` (maplibre-gl + OSM raster tiles, no API key) and
 * `Map.native.tsx` (react-native-maps) both implement this contract so callers
 * import `@/components/Map` and get the right renderer per platform without
 * branching. Coordinates everywhere are `[lng, lat]` to match the backend's
 * GeoJSON `GeoPoint`.
 */

import type { Coordinates } from '@/lib/hooks/use-location';

export type { Coordinates };

/** The role a marker plays — drives its color/icon. */
export type MapMarkerKind = 'pickup' | 'dropoff' | 'courier';

/** A single map marker. */
export interface MapMarker {
  /** Stable marker id. */
  id: string;
  /** Marker role (pickup / dropoff / live courier). */
  kind: MapMarkerKind;
  /** Position, `[lng, lat]`. */
  coordinate: Coordinates;
  /** Whether the marker can be dragged to a new position. */
  draggable?: boolean;
  /** Optional short label rendered with the marker. */
  label?: string;
}

/** Props common to both the web and native `Map` implementations. */
export interface MapProps {
  /** Markers to render (pickup/dropoff/courier). */
  markers?: MapMarker[];
  /** Initial center, `[lng, lat]`. Defaults to a sensible fallback when absent. */
  initialCenter?: Coordinates;
  /** Initial zoom level (web zoom semantics; mapped to a region delta on native). */
  initialZoom?: number;
  /**
   * Whether tapping the map places/moves a marker. The parent owns marker state;
   * this only signals that taps should emit `onPressMap`.
   */
  interactive?: boolean;
  /** Called with `[lng, lat]` when the user taps the map (when `interactive`). */
  onPressMap?: (coordinate: Coordinates) => void;
  /** Called with the marker id + new `[lng, lat]` when a draggable marker is moved. */
  onMarkerDragEnd?: (markerId: string, coordinate: Coordinates) => void;
  /** Whether to auto-fit the viewport to contain all markers. */
  fitToMarkers?: boolean;
  /** Extra class names for the map container (height is required by the caller). */
  className?: string;
}

/** A neutral default center (Madrid) used when no markers/center are supplied. */
export const DEFAULT_CENTER: Coordinates = [-3.7038, 40.4168];

/** Default zoom for a single-city view. */
export const DEFAULT_ZOOM = 12;

/** Marker fill colors per kind (hex; consumed by both platforms). */
export const MARKER_COLORS: Record<MapMarkerKind, string> = {
  pickup: '#16a34a', // green-600
  dropoff: '#dc2626', // red-600
  courier: '#2563eb', // blue-600
};

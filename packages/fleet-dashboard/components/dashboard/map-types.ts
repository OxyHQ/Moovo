/**
 * Shared Map types — platform-agnostic, NO platform imports.
 *
 * Both `Map.web.tsx` (maplibre-gl + OSM tiles) and `Map.native.tsx`
 * (react-native-maps) implement this exact prop contract, and the default
 * `Map.tsx` re-declares the component against it so consumer `tsc` resolves the
 * type without pulling in either platform's renderer.
 */

/** A point to plot on the map. */
export interface MapMarker {
  /** Stable marker id. */
  id: string;
  /** Longitude. */
  lng: number;
  /** Latitude. */
  lat: number;
  /** Marker kind — drives the pin color/shape. */
  kind: "courier" | "pickup" | "dropoff";
  /** Optional label shown on hover/press. */
  label?: string;
}

/** A map viewport center + zoom. */
export interface MapCenter {
  lng: number;
  lat: number;
  /** Zoom level (maplibre/Google zoom scale). */
  zoom: number;
}

/** Props shared by the web and native Map implementations. */
export interface FleetMapProps {
  /** Markers to plot (couriers, pickups, dropoffs). */
  markers: MapMarker[];
  /** Initial viewport. Defaults to a wide world-ish view when omitted. */
  initialCenter?: MapCenter;
  /** Map height in px (the map fills its parent's width). */
  height?: number;
}

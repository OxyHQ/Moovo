import { useMemo, useRef } from "react";
import { View, StyleSheet } from "react-native";
import MapView, {
  Marker,
  Polyline,
  UrlTile,
  type Region,
} from "react-native-maps";
import { cn } from "@/lib/utils";
import {
  type JobMapProps,
  type LngLat,
  MARKER_COLORS,
  OSM_TILE_URL,
} from "./Map.types";

/**
 * Native job map (react-native-maps over free OpenStreetMap raster tiles via
 * `UrlTile`, NO API key). `mapType="none"` removes the platform base map so only
 * the OSM raster is shown. This module is `.native.tsx`, so it is bundled ONLY on
 * native — the web bundle resolves the maplibre-based `Map.tsx` and never imports
 * react-native-maps. The route is a straight polyline for v1.
 */

/** Default span (degrees) when framing a single point. */
const SINGLE_POINT_DELTA = 0.05;

/** Extra padding factor applied to the fitted region span. */
const REGION_PADDING = 1.6;

/** Minimum lat/lng delta so two near-identical points still render a sane zoom. */
const MIN_DELTA = 0.01;

/** Compute a region that frames every supplied `[lng, lat]` point. */
function regionForPoints(points: LngLat[]): Region | undefined {
  if (points.length === 0) return undefined;
  let minLng = points[0][0];
  let maxLng = points[0][0];
  let minLat = points[0][1];
  let maxLat = points[0][1];
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (points.length === 1) {
    return {
      latitude: minLat,
      longitude: minLng,
      latitudeDelta: SINGLE_POINT_DELTA,
      longitudeDelta: SINGLE_POINT_DELTA,
    };
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(MIN_DELTA, (maxLat - minLat) * REGION_PADDING),
    longitudeDelta: Math.max(MIN_DELTA, (maxLng - minLng) * REGION_PADDING),
  };
}

export default function JobMap({ markers, route, className }: JobMapProps) {
  const mapRef = useRef<MapView | null>(null);

  const fitPoints = useMemo<LngLat[]>(
    () => [...markers.map((m) => m.coordinate), ...(route ?? [])],
    [markers, route],
  );

  const initialRegion = useMemo(() => regionForPoints(fitPoints), [fitPoints]);

  const polylineCoords = useMemo(
    () => (route ?? []).map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
    [route],
  );

  return (
    <View className={cn("h-full w-full overflow-hidden rounded-2xl", className)}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        mapType="none"
        initialRegion={initialRegion}
        showsUserLocation={false}
        toolbarEnabled={false}
      >
        <UrlTile urlTemplate={OSM_TILE_URL} maximumZ={19} flipY={false} />
        {markers.map((m) => (
          <Marker
            key={m.id}
            coordinate={{ latitude: m.coordinate[1], longitude: m.coordinate[0] }}
            title={m.label}
            pinColor={MARKER_COLORS[m.kind]}
          />
        ))}
        {polylineCoords.length >= 2 ? (
          <Polyline
            coordinates={polylineCoords}
            strokeColor={MARKER_COLORS.courier}
            strokeWidth={3}
          />
        ) : null}
      </MapView>
    </View>
  );
}

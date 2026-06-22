import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import MapView, {
  Marker,
  type Region,
  type MapPressEvent,
  type MarkerDragStartEndEvent,
} from 'react-native-maps';
import {
  type MapProps,
  type Coordinates,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MARKER_COLORS,
} from '@/components/map-types';

/**
 * Native `Map` — react-native-maps over the platform's default map provider.
 *
 * Mirrors the web maplibre implementation's `MapProps` contract. Web zoom is
 * mapped to a region latitude/longitude delta so the same `initialZoom` reads
 * similarly on both platforms. Coordinates are `[lng, lat]` to match GeoJSON; we
 * convert to react-native-maps' `{ latitude, longitude }` at the boundary.
 */

const styles = StyleSheet.create({
  map: { width: '100%', height: '100%' },
});

/** Approximate a web zoom level as a region longitude/latitude delta. */
function zoomToDelta(zoom: number): number {
  // 360° of longitude across 2^zoom tiles → a coarse but serviceable mapping.
  return 360 / 2 ** zoom;
}

/** Build a `Region` centered on `[lng, lat]` at the given zoom. */
function toRegion([lng, lat]: Coordinates, zoom: number): Region {
  const delta = zoomToDelta(zoom);
  return { latitude: lat, longitude: lng, latitudeDelta: delta, longitudeDelta: delta };
}

export default function Map({
  markers = [],
  initialCenter,
  initialZoom = DEFAULT_ZOOM,
  interactive = false,
  onPressMap,
  onMarkerDragEnd,
  fitToMarkers = false,
}: MapProps) {
  const mapRef = useRef<MapView | null>(null);

  // Fit the viewport to the markers when requested / when they change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToMarkers || markers.length === 0) {
      return;
    }
    if (markers.length === 1) {
      map.animateToRegion(toRegion(markers[0].coordinate, Math.max(initialZoom, 14)), 400);
      return;
    }
    map.fitToCoordinates(
      markers.map((m) => ({ latitude: m.coordinate[1], longitude: m.coordinate[0] })),
      { edgePadding: { top: 64, right: 64, bottom: 64, left: 64 }, animated: true },
    );
  }, [markers, fitToMarkers, initialZoom]);

  const handlePress = (e: MapPressEvent) => {
    if (!interactive) {
      return;
    }
    const { latitude, longitude } = e.nativeEvent.coordinate;
    onPressMap?.([longitude, latitude]);
  };

  return (
    <MapView
      ref={mapRef}
      style={styles.map}
      initialRegion={toRegion(initialCenter ?? markers[0]?.coordinate ?? DEFAULT_CENTER, initialZoom)}
      onPress={handlePress}
    >
      {markers.map((marker) => (
        <Marker
          key={marker.id}
          coordinate={{ latitude: marker.coordinate[1], longitude: marker.coordinate[0] }}
          pinColor={MARKER_COLORS[marker.kind]}
          draggable={marker.draggable ?? false}
          title={marker.label}
          onDragEnd={(e: MarkerDragStartEndEvent) => {
            const { latitude, longitude } = e.nativeEvent.coordinate;
            onMarkerDragEnd?.(marker.id, [longitude, latitude]);
          }}
        />
      ))}
    </MapView>
  );
}

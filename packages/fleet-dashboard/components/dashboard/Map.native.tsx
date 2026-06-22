import MapView, { Marker, UrlTile, PROVIDER_DEFAULT } from "react-native-maps";
import type { Region } from "react-native-maps";
import { View } from "react-native";
import { OSM_TILE_URL } from "@/lib/config";
import type { FleetMapProps, MapMarker } from "./map-types";

/** Pin tint per marker kind. */
const KIND_COLOR: Record<MapMarker["kind"], string> = {
  courier: "#2563eb",
  pickup: "#16a34a",
  dropoff: "#f59e0b",
};

/** Default region — a broad view used until markers recenter the map. */
const DEFAULT_REGION: Region = {
  latitude: 48.8566,
  longitude: 2.3522,
  latitudeDelta: 12,
  longitudeDelta: 12,
};

/**
 * Native fleet map (react-native-maps + OpenStreetMap raster tiles via UrlTile,
 * no API key). Metro resolves this file ONLY on native, so react-native-maps is
 * never pulled into the web bundle (web uses `Map.web.tsx`).
 */
export function FleetMap({ markers, initialCenter, height = 320 }: FleetMapProps) {
  // Frame the first marker when present, otherwise the default region.
  const region: Region =
    markers.length > 0 && markers[0]
      ? {
          latitude: markers[0].lat,
          longitude: markers[0].lng,
          latitudeDelta: 0.2,
          longitudeDelta: 0.2,
        }
      : initialCenter
        ? {
            latitude: initialCenter.lat,
            longitude: initialCenter.lng,
            latitudeDelta: 0.5,
            longitudeDelta: 0.5,
          }
        : DEFAULT_REGION;

  return (
    <View style={{ height, width: "100%", borderRadius: 16, overflow: "hidden" }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        initialRegion={region}
      >
        <UrlTile urlTemplate={OSM_TILE_URL} maximumZ={19} flipY={false} />
        {markers.map((m) => (
          <Marker
            key={m.id}
            coordinate={{ latitude: m.lat, longitude: m.lng }}
            title={m.label}
            pinColor={KIND_COLOR[m.kind]}
          />
        ))}
      </MapView>
    </View>
  );
}

export type { FleetMapProps } from "./map-types";

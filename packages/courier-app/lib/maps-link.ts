import { Platform, Linking } from "react-native";
import type { GeoPoint } from "@moovo/shared-types";

/**
 * Navigation handoff to the device's maps app (PURE construction + a single
 * `Linking.openURL`). For v1 we hand off turn-by-turn to the OS maps app rather
 * than embedding a routing engine: web/Android open a Google Maps directions URL,
 * iOS opens the native `maps:` scheme. Coordinates are GeoJSON `[lng, lat]`.
 */

/** Build the platform-appropriate "navigate to" URL for a destination point. */
export function buildMapsUrl(destination: GeoPoint, label?: string): string {
  const [lng, lat] = destination.coordinates;
  const query = label ? encodeURIComponent(label) : `${lat},${lng}`;
  if (Platform.OS === "ios") {
    return `maps:0,0?q=${query}&ll=${lat},${lng}`;
  }
  if (Platform.OS === "android") {
    return `geo:${lat},${lng}?q=${lat},${lng}(${query})`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Open the OS maps app navigating to `destination`. */
export async function openInMaps(destination: GeoPoint, label?: string): Promise<void> {
  await Linking.openURL(buildMapsUrl(destination, label));
}

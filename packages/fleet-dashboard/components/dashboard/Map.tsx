import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { FleetMapProps } from "./map-types";

/**
 * Default (platform-agnostic) Map — a clean no-op the bundler NEVER ships:
 * Metro resolves `Map.web.tsx` on web and `Map.native.tsx` on native. This file
 * exists only so consumer `tsc` (which does not do platform-extension
 * resolution) has a type to bind to WITHOUT importing maplibre-gl or
 * react-native-maps. It renders a neutral placeholder if ever reached.
 */
export function FleetMap({ height = 320 }: FleetMapProps) {
  return (
    <View
      className="items-center justify-center rounded-2xl border border-border bg-muted"
      style={{ height }}
    >
      <Text className="text-sm text-muted-foreground">Map unavailable</Text>
    </View>
  );
}

export type { FleetMapProps } from "./map-types";

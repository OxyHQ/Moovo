import { View, Pressable, ActivityIndicator } from 'react-native';
import { Crosshair } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import Map from '@/components/Map';
import type { MapMarker, MapMarkerKind } from '@/components/map-types';
import { useColorScheme } from '@/lib/useColorScheme';
import { useCurrentLocation, reverseGeocode, type Coordinates } from '@/lib/hooks/use-location';
import type { DraftEndpoint } from '@/lib/stores/shipment-draft-store';

/**
 * One endpoint editor (pickup OR dropoff): a tappable map to drop/drag the pin,
 * a "use my location" button, and the address + contact form. The map and the
 * address stay in sync — tapping/dragging or using the device location resolves
 * a reverse-geocoded address snapshot into the form, which the user can edit.
 *
 * The parent owns the draft slice and passes `value` + `onChange`; this is a
 * controlled component with no internal endpoint state (only the in-flight
 * location-permission status, owned by `useCurrentLocation`).
 */
export function EndpointPicker({
  kind,
  value,
  onChange,
}: {
  kind: Extract<MapMarkerKind, 'pickup' | 'dropoff'>;
  value: DraftEndpoint;
  onChange: (patch: Partial<DraftEndpoint>) => void;
}) {
  const { colors } = useColorScheme();
  const { loading, error, getCurrentPosition } = useCurrentLocation();

  // Resolve a coordinate → patch coordinate + reverse-geocoded address snapshot.
  const applyCoordinate = async (coordinate: Coordinates) => {
    onChange({ coordinate });
    const address = await reverseGeocode(coordinate);
    if (Object.keys(address).length > 0) {
      onChange({ coordinate, address: { ...value.address, ...address } });
    }
  };

  const handleUseMyLocation = async () => {
    const coordinate = await getCurrentPosition();
    if (coordinate) {
      await applyCoordinate(coordinate);
    }
  };

  const markers: MapMarker[] = value.coordinate
    ? [{ id: kind, kind, coordinate: value.coordinate, draggable: true }]
    : [];

  return (
    <View className="gap-3">
      {/* Map picker. */}
      <View className="h-64 overflow-hidden rounded-2xl border border-border">
        <Map
          markers={markers}
          initialCenter={value.coordinate}
          interactive
          fitToMarkers={Boolean(value.coordinate)}
          onPressMap={(coordinate) => void applyCoordinate(coordinate)}
          onMarkerDragEnd={(_id, coordinate) => void applyCoordinate(coordinate)}
        />
      </View>

      <Pressable
        onPress={handleUseMyLocation}
        accessibilityRole="button"
        disabled={loading}
        className="flex-row items-center justify-center gap-2 rounded-xl border border-border bg-card py-2.5 active:opacity-80"
      >
        {loading ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Crosshair size={16} color={colors.primary} />
        )}
        <Text className="text-sm font-medium text-primary">Use my current location</Text>
      </Pressable>
      {error ? <Text className="text-xs text-red-600">{error}</Text> : null}
      {!value.coordinate ? (
        <Text className="text-xs text-muted-foreground">
          Tap the map to set the {kind} point, or use your current location.
        </Text>
      ) : null}

      {/* Address form. */}
      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Address
        </Text>
        <Input
          value={value.address.line1 ?? ''}
          onChangeText={(line1) => onChange({ address: { ...value.address, line1 } })}
          placeholder="Street address"
        />
        <Input
          value={value.address.line2 ?? ''}
          onChangeText={(line2) => onChange({ address: { ...value.address, line2 } })}
          placeholder="Apt, suite (optional)"
        />
        <View className="flex-row gap-2">
          <Input
            value={value.address.city ?? ''}
            onChangeText={(city) => onChange({ address: { ...value.address, city } })}
            placeholder="City"
            className="flex-1"
          />
          <Input
            value={value.address.postalCode ?? ''}
            onChangeText={(postalCode) => onChange({ address: { ...value.address, postalCode } })}
            placeholder="Postal code"
            className="flex-1"
          />
        </View>
        <View className="flex-row gap-2">
          <Input
            value={value.address.region ?? ''}
            onChangeText={(region) => onChange({ address: { ...value.address, region } })}
            placeholder="Region (optional)"
            className="flex-1"
          />
          <Input
            value={value.address.country ?? ''}
            onChangeText={(country) =>
              onChange({ address: { ...value.address, country: country.toUpperCase().slice(0, 2) } })
            }
            placeholder="Country (ISO, e.g. ES)"
            autoCapitalize="characters"
            maxLength={2}
            className="flex-1"
          />
        </View>
      </View>

      {/* Contact form. */}
      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contact at this point
        </Text>
        <Input
          value={value.contactName}
          onChangeText={(contactName) => onChange({ contactName })}
          placeholder="Contact name"
        />
        <Input
          value={value.contactPhone}
          onChangeText={(contactPhone) => onChange({ contactPhone })}
          placeholder="Contact phone"
          keyboardType="phone-pad"
        />
        <Input
          value={value.notes}
          onChangeText={(notes) => onChange({ notes })}
          placeholder="Notes for the courier (optional)"
          multiline
        />
      </View>
    </View>
  );
}

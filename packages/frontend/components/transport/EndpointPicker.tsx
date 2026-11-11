import { View } from 'react-native';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import MoovoMap from '@/components/Map';
import type { MapMarker, MapMarkerKind } from '@/components/map-types';
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
        <MoovoMap
          markers={markers}
          initialCenter={value.coordinate}
          interactive
          fitToMarkers={Boolean(value.coordinate)}
          onPressMap={(coordinate) => void applyCoordinate(coordinate)}
          onMarkerDragEnd={(_id, coordinate) => void applyCoordinate(coordinate)}
        />
      </View>

      <Button
        appearance="outline"
        tone="neutral"
        leadingIcon={RiFocus3Line}
        loading={loading}
        onPress={handleUseMyLocation}
      >
        Use my current location
      </Button>
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
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
        <TextFieldInput
          label="Street address"
          value={value.address.line1 ?? ''}
          onValueChange={(line1) => onChange({ address: { ...value.address, line1 } })}
        />
        <TextFieldInput
          label="Apt, suite (optional)"
          value={value.address.line2 ?? ''}
          onValueChange={(line2) => onChange({ address: { ...value.address, line2 } })}
        />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <TextFieldInput
              label="City"
              value={value.address.city ?? ''}
              onValueChange={(city) => onChange({ address: { ...value.address, city } })}
            />
          </View>
          <View className="flex-1">
            <TextFieldInput
              label="Postal code"
              value={value.address.postalCode ?? ''}
              onValueChange={(postalCode) =>
                onChange({ address: { ...value.address, postalCode } })
              }
            />
          </View>
        </View>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <TextFieldInput
              label="Region (optional)"
              value={value.address.region ?? ''}
              onValueChange={(region) => onChange({ address: { ...value.address, region } })}
            />
          </View>
          <View className="flex-1">
            <TextFieldInput
              label="Country (ISO, e.g. ES)"
              value={value.address.country ?? ''}
              onValueChange={(country) =>
                onChange({
                  address: { ...value.address, country: country.toUpperCase().slice(0, 2) },
                })
              }
              autoCapitalize="characters"
              maxLength={2}
            />
          </View>
        </View>
      </View>

      {/* Contact form. */}
      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contact at this point
        </Text>
        <TextFieldInput
          label="Contact name"
          value={value.contactName}
          onValueChange={(contactName) => onChange({ contactName })}
        />
        <TextFieldInput
          label="Contact phone"
          value={value.contactPhone}
          onValueChange={(contactPhone) => onChange({ contactPhone })}
          keyboardType="phone-pad"
        />
        <TextFieldInput
          label="Notes for the courier (optional)"
          value={value.notes}
          onValueChange={(notes) => onChange({ notes })}
          multiline
        />
      </View>
    </View>
  );
}

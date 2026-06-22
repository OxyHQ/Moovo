import { useCallback, useState } from 'react';
import * as Location from 'expo-location';
import type { ShipmentAddress } from '@moovo/shared-types';

/**
 * Device-location + reverse-geocoding helpers for the shipment endpoint pickers.
 *
 * Both operations are imperative, user-triggered actions (the user taps "use my
 * location"), so they are exposed as async callbacks rather than a fetching
 * `useEffect`. `getCurrentPosition` requests foreground permission and returns a
 * `[lng, lat]` GeoJSON-friendly tuple; `reverseGeocode` turns a coordinate into a
 * best-effort {@link ShipmentAddress} snapshot to prefill the address form.
 */

/** A resolved coordinate, `[lng, lat]` per GeoJSON. */
export type Coordinates = [number, number];

/** Reverse-geocode a coordinate into a best-effort shipment address snapshot. */
export async function reverseGeocode([lng, lat]: Coordinates): Promise<Partial<ShipmentAddress>> {
  const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
  const place = results[0];
  if (!place) {
    return {};
  }

  // `streetNumber` + `street` make the most natural line1; fall back to the raw
  // `name` (often "123 Main St") when the structured fields are absent.
  const line1 =
    [place.streetNumber, place.street].filter(Boolean).join(' ') || place.name || undefined;

  const address: Partial<ShipmentAddress> = {};
  if (line1) address.line1 = line1;
  if (place.city) address.city = place.city;
  if (place.region) address.region = place.region;
  if (place.postalCode) address.postalCode = place.postalCode;
  // expo-location returns ISO-3166 alpha-2 in `isoCountryCode`.
  if (place.isoCountryCode) address.country = place.isoCountryCode;
  return address;
}

/** State + actions for resolving the device's current position. */
export interface UseCurrentLocation {
  /** `true` while a position request is in flight. */
  loading: boolean;
  /** A human-readable error from the last attempt, or `null`. */
  error: string | null;
  /** Request permission + resolve the current coordinate, or `null` on denial/failure. */
  getCurrentPosition: () => Promise<Coordinates | null>;
}

/** Resolve the device's current position on demand (permission-gated). */
export function useCurrentLocation(): UseCurrentLocation {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getCurrentPosition = useCallback(async (): Promise<Coordinates | null> => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        setError('Location permission was denied.');
        return null;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return [position.coords.longitude, position.coords.latitude];
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve your location.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, getCurrentPosition };
}

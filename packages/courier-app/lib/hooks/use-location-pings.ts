import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { pingJobLocation } from "@/lib/api/jobs";

/**
 * Stream the courier's GPS position to the backend while a job is active.
 *
 * When `enabled` (the job is in an active leg: accepted / picked_up / in_transit)
 * this requests foreground location permission, watches the device position, and
 * POSTs each fix to `/jobs/:id/location` so the sender's tracking map updates
 * live. It also surfaces the latest local fix so the courier's own map can render
 * their position without waiting for the round-trip. Watching the device position
 * is an inherently effectful subscription — the watcher is fully torn down when
 * the job reaches a terminal status or the screen unmounts.
 */

/** Minimum metres of movement before a new ping is emitted. */
const PING_DISTANCE_INTERVAL_M = 25;

/** Minimum milliseconds between pings (caps the upload + DB-write rate). */
const PING_TIME_INTERVAL_MS = 10_000;

/** A local GPS fix exposed to the screen. */
export interface CourierFix {
  /** `[lng, lat]` per GeoJSON. */
  coordinates: [number, number];
}

/** What {@link useLocationPings} returns. */
export interface LocationPingsState {
  /** The courier's most recent local fix, or `null` before the first one. */
  fix: CourierFix | null;
  /** Whether foreground location permission was denied. */
  permissionDenied: boolean;
}

/**
 * Watch + upload the courier's position for `jobId` while `enabled`.
 */
export function useLocationPings(jobId: string, enabled: boolean): LocationPingsState {
  const [fix, setFix] = useState<CourierFix | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Guards against firing a ping more often than the time interval even when the
  // OS delivers fixes faster than `timeInterval` (it is a hint, not a guarantee).
  const lastSentAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    const start = async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          distanceInterval: PING_DISTANCE_INTERVAL_M,
          timeInterval: PING_TIME_INTERVAL_MS,
        },
        (position) => {
          const { longitude, latitude } = position.coords;
          setFix({ coordinates: [longitude, latitude] });

          const now = Date.now();
          if (now - lastSentAtRef.current < PING_TIME_INTERVAL_MS) return;
          lastSentAtRef.current = now;

          pingJobLocation(jobId, longitude, latitude).catch(() => {
            // A dropped ping is non-fatal and self-recovering: the next GPS fix
            // re-attempts. Reset the throttle so the retry isn't delayed a full
            // interval, and surface the latest fix locally regardless.
            lastSentAtRef.current = 0;
          });
        },
      );
      if (cancelled && subscription) {
        subscription.remove();
        subscription = null;
      }
    };

    start().catch(() => {
      // Starting the watch can fail if permission is revoked mid-flight; the
      // permission state already reflects that and the watcher simply won't run.
      setPermissionDenied(true);
    });

    return () => {
      cancelled = true;
      if (subscription) {
        subscription.remove();
        subscription = null;
      }
    };
  }, [jobId, enabled]);

  return { fix, permissionDenied };
}

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OSM_TILE_URL, OSM_ATTRIBUTION } from "@/lib/config";
import type { FleetMapProps, MapMarker } from "./map-types";

/** Default viewport — a broad European/Atlantic view until markers recenter it. */
const DEFAULT_CENTER: [number, number] = [2.3522, 48.8566];
const DEFAULT_ZOOM = 4;

/** Pin color per marker kind (raw CSS — maplibre markers are DOM, not RN). */
const KIND_COLOR: Record<MapMarker["kind"], string> = {
  courier: "#2563eb",
  pickup: "#16a34a",
  dropoff: "#f59e0b",
};

/** A minimal raster style backed by OpenStreetMap tiles (no API key). */
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: [OSM_TILE_URL],
      tileSize: 256,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/** Build a small colored circular DOM pin for a marker kind. */
function makePin(kind: MapMarker["kind"]): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = "16px";
  el.style.height = "16px";
  el.style.borderRadius = "9999px";
  el.style.border = "2px solid #ffffff";
  el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
  el.style.backgroundColor = KIND_COLOR[kind];
  return el;
}

/**
 * Web fleet map (maplibre-gl + OpenStreetMap raster tiles, no API key). Creates
 * the map once on mount and reconciles markers on change. Imperative map-library
 * lifecycle with cleanup is a legitimate `useEffect`.
 *
 * This file is web-only (Metro resolves `Map.native.tsx` on native), so the web
 * bundle imports maplibre-gl here and NEVER react-native-maps.
 */
export function FleetMap({ markers, initialCenter, height = 320 }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: initialCenter
        ? [initialCenter.lng, initialCenter.lat]
        : DEFAULT_CENTER,
      zoom: initialCenter?.zoom ?? DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
    // Create-once: initialCenter is only the seed viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile markers + fit bounds when the marker set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const live = markersRef.current;
    const nextIds = new Set(markers.map((m) => m.id));

    // Remove stale markers.
    live.forEach((marker, id) => {
      if (!nextIds.has(id)) {
        marker.remove();
        live.delete(id);
      }
    });

    // Add/update markers.
    for (const m of markers) {
      const existing = live.get(m.id);
      if (existing) {
        existing.setLngLat([m.lng, m.lat]);
      } else {
        const marker = new maplibregl.Marker({ element: makePin(m.kind) }).setLngLat([
          m.lng,
          m.lat,
        ]);
        if (m.label) {
          marker.setPopup(new maplibregl.Popup({ offset: 12 }).setText(m.label));
        }
        marker.addTo(map);
        live.set(m.id, marker);
      }
    }

    // Fit to all markers (only when there is something to frame).
    if (markers.length === 1) {
      const only = markers[0];
      if (only) map.easeTo({ center: [only.lng, only.lat], zoom: 12, duration: 600 });
    } else if (markers.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      for (const m of markers) bounds.extend([m.lng, m.lat]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 600 });
    }
  }, [markers]);

  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%", borderRadius: 16, overflow: "hidden" }}
    />
  );
}

export type { FleetMapProps } from "./map-types";

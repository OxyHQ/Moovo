import { useEffect, useRef } from "react";
import { View } from "react-native";
import {
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  NavigationControl,
  LngLatBounds,
  type LngLatBoundsLike,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cn } from "@/lib/utils";
import {
  type JobMapProps,
  type LngLat,
  MARKER_COLORS,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  DEFAULT_ZOOM,
} from "./Map.types";

/**
 * Web job map (maplibre-gl + free OpenStreetMap raster tiles, NO API key).
 *
 * This is the DEFAULT (`.tsx`) module, so it is the implementation tsc resolves
 * AND the one web Metro bundles — `react-native-maps` (the native renderer in
 * `Map.native.tsx`) is therefore never pulled into the web bundle. The map is
 * created imperatively against the container's DOM node and kept in sync with the
 * `markers` / `route` props; the route is a straight polyline for v1.
 */

/** maplibre style: a single OSM raster source + layer (no key, no vendor style). */
const RASTER_STYLE: StyleSpecification = {
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

/** Id of the route line source + layer. */
const ROUTE_LAYER_ID = "job-route";

function toBounds(points: LngLat[]): LngLatBoundsLike {
  const bounds = new LngLatBounds(points[0], points[0]);
  for (const point of points) bounds.extend(point);
  return bounds;
}

export default function JobMap({ markers, route, className }: JobMapProps) {
  const containerRef = useRef<View | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);

  // Create the map once against the container DOM node, and tear it down on
  // unmount. Map creation against a DOM element is inherently effectful.
  useEffect(() => {
    // On react-native-web a View ref resolves to its backing DOM node.
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: RASTER_STYLE,
      center: markers[0]?.coordinate ?? [0, 0],
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Sync markers + route line + viewport whenever the data changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const render = () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = markers.map((m) => {
        const el = document.createElement("div");
        el.style.width = "16px";
        el.style.height = "16px";
        el.style.borderRadius = "9999px";
        el.style.border = "2px solid #ffffff";
        el.style.backgroundColor = MARKER_COLORS[m.kind];
        el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
        el.setAttribute("aria-label", m.label);
        el.setAttribute("title", m.label);
        return new MapLibreMarker({ element: el })
          .setLngLat(m.coordinate)
          .addTo(map);
      });

      const existing = map.getLayer(ROUTE_LAYER_ID);
      if (existing) {
        map.removeLayer(ROUTE_LAYER_ID);
        map.removeSource(ROUTE_LAYER_ID);
      }
      if (route && route.length >= 2) {
        map.addSource(ROUTE_LAYER_ID, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: route },
          },
        });
        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_LAYER_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": MARKER_COLORS.courier, "line-width": 3, "line-dasharray": [2, 1.5] },
        });
      }

      const fitPoints: LngLat[] = [
        ...markers.map((m) => m.coordinate),
        ...(route ?? []),
      ];
      if (fitPoints.length === 1) {
        map.jumpTo({ center: fitPoints[0], zoom: DEFAULT_ZOOM });
      } else if (fitPoints.length > 1) {
        map.fitBounds(toBounds(fitPoints), { padding: 56, maxZoom: 15, duration: 400 });
      }
    };

    if (map.isStyleLoaded()) {
      render();
    } else {
      map.once("load", render);
    }
  }, [markers, route]);

  return (
    <View
      ref={containerRef}
      className={cn("h-full w-full overflow-hidden rounded-2xl", className)}
    />
  );
}

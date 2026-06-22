import { useEffect, useRef } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  type MapProps,
  type MapMarker,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MARKER_COLORS,
} from '@/components/map-types';

/**
 * Web `Map` — maplibre-gl over OpenStreetMap raster tiles (NO API key).
 *
 * The raster style points at the public OSM tile servers, so the map renders
 * with zero credentials. maplibre is an imperative DOM library, so the map +
 * markers live in refs and are reconciled inside effects (a legitimate effect
 * use: bridging an external, non-React library). Coordinates are `[lng, lat]`.
 */

/** A key-free OSM raster tile style. */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** Build a colored teardrop pin element for a marker kind. */
function createPinElement(marker: MapMarker): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = '22px';
  el.style.height = '22px';
  el.style.borderRadius = '50% 50% 50% 0';
  el.style.transform = 'rotate(-45deg)';
  el.style.backgroundColor = MARKER_COLORS[marker.kind];
  el.style.border = '2px solid #ffffff';
  el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
  el.style.cursor = marker.draggable ? 'grab' : 'default';
  if (marker.label) {
    el.title = marker.label;
  }
  return el;
}

export default function Map({
  markers = [],
  initialCenter,
  initialZoom = DEFAULT_ZOOM,
  interactive = false,
  onPressMap,
  onMarkerDragEnd,
  fitToMarkers = false,
  className,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRefs = useRef<maplibregl.Marker[]>([]);
  // Latest callbacks held in a ref so the map-init effect does not re-run when a
  // parent re-creates its handlers (the map must be created exactly once).
  const handlersRef = useRef({ onPressMap, onMarkerDragEnd, interactive });
  handlersRef.current = { onPressMap, onMarkerDragEnd, interactive };

  // Create the map exactly once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const map = new maplibregl.Map({
      container,
      style: OSM_STYLE,
      center: initialCenter ?? DEFAULT_CENTER,
      zoom: initialZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (handlersRef.current.interactive) {
        handlersRef.current.onPressMap?.([e.lngLat.lng, e.lngLat.lat]);
      }
    };
    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
      map.remove();
      mapRef.current = null;
    };
    // Intentionally created once; center/zoom changes are reconciled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile markers whenever they change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    for (const m of markerRefs.current) {
      m.remove();
    }
    markerRefs.current = markers.map((marker) => {
      const mlMarker = new maplibregl.Marker({
        element: createPinElement(marker),
        draggable: marker.draggable ?? false,
        anchor: 'bottom',
      })
        .setLngLat(marker.coordinate)
        .addTo(map);
      if (marker.draggable) {
        mlMarker.on('dragend', () => {
          const { lng, lat } = mlMarker.getLngLat();
          handlersRef.current.onMarkerDragEnd?.(marker.id, [lng, lat]);
        });
      }
      return mlMarker;
    });
  }, [markers]);

  // Fit the viewport to the markers when requested.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToMarkers || markers.length === 0) {
      return;
    }
    if (markers.length === 1) {
      map.easeTo({ center: markers[0].coordinate, zoom: Math.max(map.getZoom(), 13) });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const marker of markers) {
      bounds.extend(marker.coordinate);
    }
    map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration: 500 });
  }, [markers, fitToMarkers]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}

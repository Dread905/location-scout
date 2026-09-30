/**
 * Route map rendering: directed line segments with a dash-animation highlight.
 *
 * Layered route paint keeps routes legible over both the vector basemap and
 * satellite imagery:
 * - 'route-glow': broad translucent contrast bed.
 * - 'route-casing': crisp high-contrast outline.
 * - 'route-lines': the typed route line (sprint=solid, circuit=dashed).
 * - 'route-dash-casing' + 'route-dashes': animated direction pulse with an
 *   opposite-colour casing and a time-aware foreground.
 *
 * The map source 'routes' is a GeoJSON LineString FeatureCollection with one
 * Feature per route. Keeping long routes intact avoids multiplying a 1,000-point
 * route into 999 independent feature/layer evaluations.
 *
 * Vertex handles during editing are driven by the RouteEditor UI layer.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { GeoJSONSource } from 'maplibre-gl';
import type { Route } from '../api.js';

export const ROUTE_LAYERS = ['route-glow', 'route-casing', 'route-lines', 'route-dash-casing', 'route-dashes', 'route-staging-halo', 'route-staging'] as const;

/** Layer IDs — also re-exported for clickable list and toggling. */
export const ROUTE_GLOW_LAYER = 'route-glow';
export const ROUTE_CASING_LAYER = 'route-casing';
export const ROUTE_LINE_LAYER = 'route-lines';
export const ROUTE_DASH_CASING_LAYER = 'route-dash-casing';
export const ROUTE_DASH_LAYER = 'route-dashes';
export const ROUTE_STAGING_HALO_LAYER = 'route-staging-halo';
export const ROUTE_STAGING_LAYER = 'route-staging';
export const ROUTE_SOURCE = 'routes';
export const ROUTE_STAGING_SOURCE = 'route-staging-pts';

const ROUTE_COLOR = '#f97316';   // orange-500
const ROUTE_CIRCUIT_COLOR = '#a855f7'; // purple-500
const ROUTE_CASING_DARK = '#05070f';
const ROUTE_CASING_LIGHT = '#fff7ed';
const ROUTE_DAY_DASH = '#111827';
const ROUTE_TWILIGHT_DASH = '#fef08a';
const ROUTE_NIGHT_DASH = '#f8fafc';

/** Add route sources and layers to an already-initialised map. */
export function initRouteLayers(map: MlMap, beforeLayer?: string) {
  const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: empty(), lineMetrics: true });
  map.addSource(ROUTE_STAGING_SOURCE, { type: 'geojson', data: empty() });

  map.addLayer({
    id: ROUTE_GLOW_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['get', 'selected'], ROUTE_CASING_LIGHT, ROUTE_CASING_DARK] as any,
      'line-width': ['case', ['get', 'selected'], 13, 10] as any,
      'line-opacity': ['case', ['get', 'selected'], 0.42, 0.28] as any,
      'line-blur': 2.8,
    },
  }, beforeLayer);

  map.addLayer({
    id: ROUTE_CASING_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_CASING_DARK,
      'line-width': ['case', ['get', 'selected'], 8, 6] as any,
      'line-opacity': 0.95,
    },
  }, beforeLayer);

  // Base line — thicker sprint/circuit line.
  map.addLayer({
    id: ROUTE_LINE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match', ['get', 'type'],
        'circuit', ROUTE_CIRCUIT_COLOR,
        ROUTE_COLOR,
      ] as any,
      'line-width': ['case', ['get', 'selected'], 5, 3.5] as any,
      'line-opacity': 0.9,
      'line-dasharray': ['match', ['get', 'type'], 'circuit', ['literal', [1.8, 1.1]], ['literal', [1, 0]]] as any,
    },
  }, beforeLayer);

  // Animated direction dashes — a short high-contrast segment slides along the route line.
  map.addLayer({
    id: ROUTE_DASH_CASING_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['case', ['get', 'selected'], 6, 5] as any,
      'line-opacity': 1,
      'line-gradient': routePulseGradient(0, routeDashPalette(30).halo),
    },
  }, beforeLayer);

  map.addLayer({
    id: ROUTE_DASH_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['case', ['get', 'selected'], 3.5, 2.5] as any,
      'line-opacity': 1,
      'line-gradient': routePulseGradient(0, routeDashPalette(30).foreground),
    },
  }, beforeLayer);

  // Staging point marker: a labelled badge, separate from route vertices.
  map.addLayer({
    id: ROUTE_STAGING_HALO_LAYER,
    type: 'circle',
    source: ROUTE_STAGING_SOURCE,
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 14, 12] as any,
      'circle-color': ROUTE_CASING_DARK,
      'circle-opacity': 0.88,
      'circle-stroke-color': ROUTE_CASING_LIGHT,
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 2] as any,
    },
  }, beforeLayer);

  map.addLayer({
    id: ROUTE_STAGING_LAYER,
    type: 'symbol',
    source: ROUTE_STAGING_SOURCE,
    layout: {
      'text-field': 'S',
      'text-size': ['case', ['get', 'selected'], 14, 12] as any,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#fef08a',
      'text-halo-color': ROUTE_CASING_DARK,
      'text-halo-width': 2,
    },
  }, beforeLayer);
}

export function routeFeatureCollections(routes: Route[], selectedId: string | null): {
  segments: GeoJSON.FeatureCollection;
  staging: GeoJSON.FeatureCollection;
} {
  const features: GeoJSON.Feature[] = [];
  const stagingFeatures: GeoJSON.Feature[] = [];

  for (const route of routes) {
    if (route.vertices.length >= 2) {
      const coordinates = route.type === 'circuit'
        ? [...route.vertices, route.vertices[0]]
        : route.vertices;
      features.push({
        type: 'Feature',
        properties: {
          id: route.id,
          routeId: route.id,
          type: route.type,
          selected: route.id === selectedId,
        },
        geometry: { type: 'LineString', coordinates },
      });
    }

    if (route.staging) {
      stagingFeatures.push({
        type: 'Feature',
        properties: { id: route.id, routeId: route.id, selected: route.id === selectedId },
        geometry: { type: 'Point', coordinates: [route.staging.lng, route.staging.lat] },
      });
    }
  }

  return {
    segments: { type: 'FeatureCollection', features },
    staging: { type: 'FeatureCollection', features: stagingFeatures },
  };
}

/** Push a new routes FeatureCollection to the map. */
export function updateRoutes(map: MlMap, routes: Route[], selectedId: string | null) {
  const src = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
  const stagSrc = map.getSource(ROUTE_STAGING_SOURCE) as GeoJSONSource | undefined;
  if (!src || !stagSrc) return;

  const { segments, staging } = routeFeatureCollections(routes, selectedId);
  src.setData(segments);
  stagSrc.setData(staging);
}

const DASH_FRAME_MS = 120;

/** Advance the direction pulse without forcing a paint update every viewport frame. */
export function stepRouteDashAnimation(
  map: MlMap,
  state: { phase: number; lastPaintAt?: number },
  speed = 0.01,
  sunAltitudeDeg = 30,
  now = performance.now(),
): void {
  if (!map.getLayer(ROUTE_DASH_LAYER) || map.getLayoutProperty(ROUTE_DASH_LAYER, 'visibility') === 'none') return;
  if (now - (state.lastPaintAt ?? -Infinity) < DASH_FRAME_MS) return;
  state.lastPaintAt = now;
  state.phase = (state.phase + speed) % 1;
  const palette = routeDashPalette(sunAltitudeDeg);
  if (map.getLayer(ROUTE_DASH_CASING_LAYER)) {
    map.setPaintProperty(ROUTE_DASH_CASING_LAYER, 'line-gradient', routePulseGradient(state.phase, palette.halo));
  }
  map.setPaintProperty(ROUTE_DASH_LAYER, 'line-gradient', routePulseGradient(state.phase, palette.foreground));
}

export function routeDashPalette(sunAltitudeDeg: number) {
  if (sunAltitudeDeg < -3) return { foreground: ROUTE_NIGHT_DASH, halo: ROUTE_CASING_DARK };
  if (sunAltitudeDeg < 8) return { foreground: ROUTE_TWILIGHT_DASH, halo: ROUTE_CASING_DARK };
  return { foreground: ROUTE_DAY_DASH, halo: ROUTE_CASING_LIGHT };
}

export function routePulseGradient(phase: number, color: string) {
  const width = 0.18;
  const head = Math.max(0.001, Math.min(0.999, phase));
  const tail = Math.max(0, head - width);
  const fade = Math.min(1, head + width * 0.35);
  const transparent = transparentize(color);
  const stops: any[] = [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0, transparent,
  ];
  if (tail > 0) stops.push(tail, transparent);
  stops.push(head, color);
  if (fade < 1) stops.push(fade, transparent);
  stops.push(1, transparent);
  return stops as any;
}

function transparentize(hex: string) {
  return `${hex}00`;
}

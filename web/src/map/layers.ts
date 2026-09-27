/** MapLibre sources and layers: base extras (imagery, DEM), light (mood, rays, shadows) and our places/spots. */
import { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Place, Spot } from '../api.js';
import { destination, wedge } from './geo.js';
import { buildingShadows, MIN_SHADOW_ALT } from './shadows.js';

const SHADOW_COLOR = '#0a0c1a';
import { moodAt, moonPos, sunPos, sunriseSunset } from './sun.js';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const FONT = ['Noto Sans Regular'];

export const CHILD_SPOT_ZOOM = 13;
export const SHADOW_ZOOM = 15;

type FC = GeoJSON.FeatureCollection;
const empty = (): FC => ({ type: 'FeatureCollection', features: [] });
const src = (map: MlMap, id: string) => map.getSource(id) as GeoJSONSource | undefined;
export const setData = (map: MlMap, id: string, data: FC) => src(map, id)?.setData(data);

/** Metres per screen pixel at the map's centre and zoom. */
export const metresPerPixel = (map: MlMap) => (156_543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();

function styleLayers(map: MlMap) {
  return map.getStyle().layers ?? [];
}
export function buildingLayerIds(map: MlMap): string[] {
  return styleLayers(map).filter((l) => 'source-layer' in l && l['source-layer'] === 'building').map((l) => l.id);
}

export function initLayers(map: MlMap) {
  const layers = styleLayers(map);
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
  const firstRoad = layers.find((l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'transportation')?.id ?? firstSymbol;
  const firstBuilding = buildingLayerIds(map)[0] ?? firstSymbol;

  map.addSource('imagery', { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 17, attribution: 'Imagery © Esri' });
  map.addLayer({ id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' } }, firstRoad);

  const dem = { type: 'raster-dem' as const, tiles: [TERRARIUM], tileSize: 256, maxzoom: 15, encoding: 'terrarium' as const,
    attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' };
  map.addSource('dem', dem);
  map.addSource('terrain', dem); // a second source for 3D terrain, as MapLibre recommends
  map.setTerrain({ source: 'terrain', exaggeration: 1.4 }); // always on, so tilting by hand shows relief too
  map.addLayer({
    id: 'hillshade', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-illumination-anchor': 'map', 'hillshade-method': 'combined', 'hillshade-exaggeration': 0.5 },
  }, firstRoad);

  // Terrain self-shadowing in the building-shadow tone: shadow side only, lit side transparent.
  map.addLayer({
    id: 'terrain-shadow', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-illumination-anchor': 'map', 'hillshade-method': 'standard', 'hillshade-exaggeration': 0,
      'hillshade-highlight-color': 'rgba(0,0,0,0)', 'hillshade-accent-color': 'rgba(0,0,0,0)', 'hillshade-shadow-color': SHADOW_COLOR },
  }, firstRoad);

  map.addSource('shadows', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'shadows', type: 'fill', source: 'shadows', paint: { 'fill-color': SHADOW_COLOR, 'fill-opacity': 0.3 } }, firstBuilding);

  map.addSource('mood', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
  map.addLayer({ id: 'mood', type: 'fill', source: 'mood', paint: { 'fill-color': '#000', 'fill-opacity': 0, 'fill-antialias': false } }, firstSymbol);

  // Ours, above everything in the base style.
  map.addSource('place-outlines', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-fill', type: 'fill', source: 'place-outlines', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#f5a623', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'place-line', type: 'line', source: 'place-outlines',
    paint: { 'line-color': '#f5a623', 'line-width': 2, 'line-opacity': 0.8 } });

  map.addSource('wedges', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'wedges', type: 'fill', source: 'wedges', minzoom: CHILD_SPOT_ZOOM,
    paint: { 'fill-color': ['case', ['get', 'good'], '#f5a623', '#4cc3ff'], 'fill-opacity': ['case', ['get', 'selected'], 0.4, 0.2] } });

  map.addSource('rays', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'rays', type: 'line', source: 'rays', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'sun', '#ffd23f', 'moon', '#dfe7ff', 'sunrise', '#ff9d4d', '#ff6a3d'],
      'line-width': ['match', ['get', 'kind'], 'sun', 4, 'moon', 3, 2],
      'line-opacity': ['case', ['get', 'up'], 0.95, 0.4],
      'line-dasharray': ['match', ['get', 'kind'], 'sunrise', ['literal', [2, 2]], 'sunset', ['literal', [2, 2]], ['literal', [1, 0]]],
    } });

  map.addSource('draft', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#4ade80', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#4ade80', 'line-width': 2, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#4ade80', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 2 } });

  map.addSource('place-points', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-points', type: 'circle', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM,
    paint: { 'circle-radius': 14, 'circle-color': '#171a21', 'circle-stroke-color': '#f5a623', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'place-count', type: 'symbol', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM,
    layout: { 'text-field': ['to-string', ['get', 'count']], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#f5a623' } });
  map.addLayer({ id: 'place-label', type: 'symbol', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM, minzoom: 9,
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.7], 'text-anchor': 'top' },
    paint: { 'text-color': '#e9ecf3', 'text-halo-color': '#0e1014', 'text-halo-width': 1.5 } });

  const spotPaint = {
    'circle-radius': ['case', ['get', 'selected'], 9, 7] as any,
    'circle-color': ['case', ['get', 'good'], '#f5a623', '#4cc3ff'] as any,
    'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#0e1014'] as any,
    'circle-stroke-width': 2,
  };
  const spotLabel = {
    layout: { 'text-field': ['get', 'name'] as any, 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1] as [number, number], 'text-anchor': 'top' as const, 'text-optional': true },
    paint: { 'text-color': '#e9ecf3', 'text-halo-color': '#0e1014', 'text-halo-width': 1.5 },
  };

  map.addSource('place-spots', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-spots', type: 'circle', source: 'place-spots', minzoom: CHILD_SPOT_ZOOM, paint: spotPaint });
  map.addLayer({ id: 'place-spots-label', type: 'symbol', source: 'place-spots', minzoom: 14, ...spotLabel });

  map.addSource('spots', { type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 12, clusterRadius: 40 });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'spots', filter: ['has', 'point_count'],
    paint: { 'circle-radius': 15, 'circle-color': '#1d212b', 'circle-stroke-color': '#4cc3ff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'spots', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#4cc3ff' } });
  map.addLayer({ id: 'spot-points', type: 'circle', source: 'spots', filter: ['!', ['has', 'point_count']], paint: spotPaint });
  map.addLayer({ id: 'spot-label', type: 'symbol', source: 'spots', filter: ['!', ['has', 'point_count']], minzoom: 12, ...spotLabel });
}

/** Phase 3: planes, rail, trains, candidates. Kept separate from initLayers, called once alongside it. */
export function initFeedLayers(map: MlMap) {
  // Rail network: lines coloured by usage/service, industrial/mine sites highlighted.
  map.addSource('rail', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'rail-lines', type: 'line', source: 'rail', filter: ['==', ['geometry-type'], 'LineString'], layout: { visibility: 'none' },
    paint: {
      'line-color': ['match', ['get', 'usage'], 'main', '#4cc3ff', 'branch', '#7fd8a0', ['match', ['get', 'service'], 'siding', '#c98a3a', 'yard', '#c98a3a', '#8a93a6']],
      'line-width': ['match', ['get', 'usage'], 'main', 2.5, 1.5],
    },
  });
  map.addLayer({
    id: 'rail-industrial', type: 'circle', source: 'rail', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
    paint: { 'circle-radius': 5, 'circle-color': ['case', ['==', ['get', 'kind'], 'mine'], '#c94c3a', '#c98a3a'], 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1 },
  });

  // Planes: an emoji symbol rotated to track, a dashed +15min projection, and a ghost at map time.
  map.addSource('planes', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes', type: 'symbol', source: 'planes', layout: {
    visibility: 'none', 'text-field': '✈', 'text-size': 18, 'text-rotate': ['get', 'track'], 'text-rotation-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-halo-color': '#0e1014', 'text-halo-width': 1 } });
  map.addSource('planes-proj', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-proj', type: 'line', source: 'planes-proj', layout: { visibility: 'none' },
    paint: { 'line-color': '#dfe7ff', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });
  map.addSource('planes-ghost', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-ghost', type: 'circle', source: 'planes-ghost', layout: { visibility: 'none' },
    paint: { 'circle-radius': 5, 'circle-color': '#dfe7ff', 'circle-opacity': 0.5, 'circle-stroke-color': '#dfe7ff', 'circle-stroke-width': 1 } });

  // Trains: live (realtime position) vs scheduled (interpolated).
  map.addSource('trains', { type: 'geojson', data: empty() });
  // Live: solid green with a bright ring. Scheduled (estimate): hollow grey ring, so it reads as a guess.
  map.addLayer({ id: 'trains', type: 'circle', source: 'trains', layout: { visibility: 'none' }, paint: {
    'circle-radius': ['case', ['==', ['get', 'status'], 'live'], 7, 5],
    'circle-color': ['case', ['==', ['get', 'status'], 'live'], '#22c55e', '#8a93a6'],
    'circle-opacity': ['case', ['==', ['get', 'status'], 'live'], 1, 0.25],
    'circle-stroke-color': ['case', ['==', ['get', 'status'], 'live'], '#f0fdf4', '#8a93a6'],
    'circle-stroke-width': ['case', ['==', ['get', 'status'], 'live'], 2, 1.5],
  } });

  // OSM candidates: muted, distinct from real spots.
  map.addSource('candidates', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'candidates', type: 'circle', source: 'candidates', layout: { visibility: 'none' },
    paint: { 'circle-radius': 6, 'circle-color': '#6b7280', 'circle-opacity': 0.55, 'circle-stroke-color': '#e9ecf3', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.6 } });
}

export function setLayerVisible(map: MlMap, layerIds: string[], on: boolean) {
  for (const id of layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

export function updateRail(map: MlMap, fc: GeoJSON.FeatureCollection) {
  setData(map, 'rail', fc);
}

export function updatePlanes(
  map: MlMap,
  planes: { hex: string; lat: number; lon: number; track: number | null }[],
  projections: { hex: string; coords: [number, number][] }[],
  ghosts: { hex: string; lat: number; lon: number }[]
) {
  setData(map, 'planes', { type: 'FeatureCollection', features: planes.map((p) => ({
    type: 'Feature', properties: { id: p.hex, track: p.track ?? 0 }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })) });
  setData(map, 'planes-proj', { type: 'FeatureCollection',
    features: projections.map((p) => ({ type: 'Feature', properties: { id: p.hex }, geometry: { type: 'LineString', coordinates: p.coords } })) });
  setData(map, 'planes-ghost', { type: 'FeatureCollection', features: ghosts.map((g) => ({ type: 'Feature', properties: { id: g.hex }, geometry: { type: 'Point', coordinates: [g.lon, g.lat] } })) });
}

export function updateTrains(map: MlMap, positions: { tripId: string; route: string; headsign: string; status: string; delaySec: number; lat: number; lng: number }[]) {
  setData(map, 'trains', { type: 'FeatureCollection', features: positions.map((p) => ({
    type: 'Feature', properties: { id: p.tripId, route: p.route, headsign: p.headsign, status: p.status, delaySec: p.delaySec }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  })) });
}

export function updateCandidates(map: MlMap, candidates: { id: string; name: string; lat: number; lng: number }[]) {
  setData(map, 'candidates', { type: 'FeatureCollection', features: candidates.map((c) => ({
    type: 'Feature', properties: { id: c.id, name: c.name }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
  })) });
}

export const CLICKABLE = ['spot-points', 'place-spots', 'clusters', 'place-points', 'place-fill', 'place-line', 'candidates'];

export function setImagery(map: MlMap, on: boolean) {
  map.setLayoutProperty('imagery', 'visibility', on ? 'visible' : 'none');
}

/** Terrain height is always on; the 3D toggle only tilts the camera. */
export function setTerrain3d(map: MlMap, on: boolean) {
  map.easeTo({ pitch: on ? 60 : 0, duration: 600 });
}

/** Hillshade light from the sun, and a tint that follows its altitude. */
export function updateMood(map: MlMap, sun: { azimuth: number; altitude: number }) {
  const up = sun.altitude > 0;
  map.setPaintProperty('hillshade', 'hillshade-illumination-direction', sun.azimuth);
  map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', Math.min(90, Math.max(2, sun.altitude)));
  map.setPaintProperty('hillshade', 'hillshade-exaggeration', up ? 0.55 : 0.25);
  map.setPaintProperty('hillshade', 'hillshade-highlight-color', up ? (sun.altitude < 8 ? 'rgba(255,190,120,0.55)' : 'rgba(255,255,255,0.4)') : 'rgba(0,0,0,0)');
  map.setPaintProperty('hillshade', 'hillshade-shadow-color', up ? 'rgba(20,20,40,0.6)' : 'rgba(0,0,10,0.5)');
  const mood = moodAt(sun.altitude);
  map.setPaintProperty('mood', 'fill-color', mood.color);
  map.setPaintProperty('mood', 'fill-opacity', mood.opacity);
  map.setPaintProperty('imagery', 'raster-brightness-max', Math.max(0.35, 1 - mood.opacity * 0.9));
}

/** Current sun and moon azimuth rays from `origin`, plus the day's sunrise and sunset azimuths. */
export function updateRays(map: MlMap, origin: { lat: number; lng: number }, time: Date) {
  const km = (metresPerPixel(map) * 240) / 1000;
  const { lat, lng } = origin;
  const ray = (kind: string, az: number, up: boolean, scale = 1): GeoJSON.Feature => ({
    type: 'Feature', properties: { kind, up },
    geometry: { type: 'LineString', coordinates: [[lng, lat], destination(lat, lng, az, km * scale)] },
  });
  const sun = sunPos(time, lat, lng);
  const moon = moonPos(time, lat, lng);
  const rs = sunriseSunset(time, lat, lng);
  const features = [
    ...(rs.sunrise ? [ray('sunrise', rs.sunrise.azimuth, true, 1.15)] : []),
    ...(rs.sunset ? [ray('sunset', rs.sunset.azimuth, true, 1.15)] : []),
    ray('moon', moon.azimuth, moon.altitude > 0, 0.8),
    ray('sun', sun.azimuth, sun.altitude > 0),
  ];
  setData(map, 'rays', { type: 'FeatureCollection', features });
}

/** Building shadows for what's on screen, cleared when zoomed out or the sun is down; terrain shadow follows the sun and fades out at night. */
export function updateShadows(map: MlMap, sun: { azimuth: number; altitude: number }) {
  if (map.getLayer('terrain-shadow')) {
    // Full strength once the sun is a few degrees up, gone by the time it sets.
    const k = Math.min(1, Math.max(0, sun.altitude / 4));
    map.setPaintProperty('terrain-shadow', 'hillshade-illumination-direction', sun.azimuth);
    map.setPaintProperty('terrain-shadow', 'hillshade-illumination-altitude', Math.min(90, Math.max(MIN_SHADOW_ALT, sun.altitude)));
    map.setPaintProperty('terrain-shadow', 'hillshade-exaggeration', 0.6 * k);
    map.setLayoutProperty('terrain-shadow', 'visibility', k > 0 ? 'visible' : 'none');
  }
  if (map.getZoom() < SHADOW_ZOOM || sun.altitude <= 0) return setData(map, 'shadows', empty());
  const layers = buildingLayerIds(map).filter((id) => map.getLayer(id));
  if (!layers.length) return;
  const seen = new Set<string>();
  const features = map.queryRenderedFeatures({ layers }).filter((f) => {
    const key = `${f.id}:${JSON.stringify((f.geometry as GeoJSON.Polygon).coordinates?.[0]?.[0])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  setData(map, 'shadows', buildingShadows(features, sun.azimuth, sun.altitude));
}

/** Places and spots into their sources. `good` marks spots good at map time; `selectedId` highlights one. */
export function updatePlacesAndSpots(map: MlMap, places: Place[], spots: Spot[], good: (s: Spot) => boolean, selectedId: string | null) {
  const point = (s: Spot): GeoJSON.Feature => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { id: s.id, name: s.name, good: good(s), selected: s.id === selectedId },
  });
  const placeIds = new Set(places.map((p) => p.id));
  const child = spots.filter((s) => s.placeId && placeIds.has(s.placeId));
  const standalone = spots.filter((s) => !s.placeId || !placeIds.has(s.placeId));
  const counts = new Map<string, number>();
  for (const s of child) counts.set(s.placeId!, (counts.get(s.placeId!) ?? 0) + 1);

  setData(map, 'spots', { type: 'FeatureCollection', features: standalone.map(point) });
  setData(map, 'place-spots', { type: 'FeatureCollection', features: child.map(point) });
  setData(map, 'place-points', {
    type: 'FeatureCollection',
    features: places.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id, name: p.name, count: counts.get(p.id) ?? 0 } })),
  });
  setData(map, 'place-outlines', {
    type: 'FeatureCollection',
    features: places.filter((p) => p.geom).map((p) => ({ type: 'Feature', geometry: p.geom as GeoJSON.Geometry, properties: { id: p.id, name: p.name } })),
  });
  updateWedges(map, spots, good, selectedId);
}

export function updateWedges(map: MlMap, spots: Spot[], good: (s: Spot) => boolean, selectedId: string | null) {
  const km = (metresPerPixel(map) * 55) / 1000;
  setData(map, 'wedges', {
    type: 'FeatureCollection',
    features: spots.filter((s) => s.facingDeg != null).map((s) => ({
      type: 'Feature', properties: { id: s.id, good: good(s), selected: s.id === selectedId },
      geometry: { type: 'Polygon', coordinates: [wedge(s.lat, s.lng, s.facingDeg!, s.fovDeg ?? 60, km)] },
    })),
  });
}

/** The outline being drawn: its vertices, plus the line or polygon through them. */
export function updateDraft(map: MlMap, coords: [number, number][], kind: 'polygon' | 'line') {
  const features: GeoJSON.Feature[] = coords.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
  if (kind === 'polygon' && coords.length >= 3) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] } });
  } else if (coords.length >= 2) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }
  setData(map, 'draft', { type: 'FeatureCollection', features });
}

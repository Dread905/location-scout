/**
 * The `terrainshadow://` protocol: one shadow raster for terrain and buildings, rendered by Web Workers, keyed by the
 * (rounded) sun, which parts are on and a building-shadow version in the URL. Building shadow polygons (from the
 * shadows worker) are rasterised into the same mask as terrain, so where both fall the ground isn't darkened twice.
 */
import { addProtocol, type Map as MlMap, type RasterTileSource } from 'maplibre-gl';
import type { ShadowRequest } from './terrainShadow.worker.js';
import { tileRings } from './terrainShadow.js';

export const TERRAIN_SHADOW_MAX_DEM_Z = 12; // DEM sampled at <= z12; tiles above cut the terrain mask from z12
export const SHADOW_RASTER_MAX_Z = 18; // building shadows rasterised up to here; MapLibre overzooms above
let buildings: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
let buildingsVer = 0;
let color: [number, number, number] = [10, 12, 26];
let workers: Worker[] = [];
let nextId = 0, rr = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
let registered = false;

function pool(): Worker[] {
  if (workers.length) return workers;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 2) - 1));
  workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL('./terrainShadow.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; buf?: ArrayBuffer; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.buf) p.resolve(e.data.buf); else p.reject(new Error(e.data.error ?? 'terrain shadow failed'));
    };
    return w;
  });
  return workers;
}

export function registerTerrainShadowProtocol(shadowColor: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(shadowColor);
  if (m) color = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  if (registered) return;
  registered = true;
  addProtocol('terrainshadow', (params, abort) => {
    const u = /^terrainshadow:\/\/(\d+)\/(\d+)\/(\d+)\?az=([-\d.]+)&alt=([-\d.]+)(?:&t=([01]))?(?:&b=(\d+))?/.exec(params.url);
    if (!u) return Promise.reject(new Error(`bad url ${params.url}`));
    const [z, x, y, az, alt] = u.slice(1, 6).map(Number);
    const terrain = u[6] !== '0';
    const rings = u[7] && Number(u[7]) === buildingsVer ? tileRings(buildings, z, x, y) : [];
    const id = nextId++;
    const ws = pool();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (data) => resolve({ data }), reject });
      abort.signal.addEventListener('abort', () => { pending.delete(id); reject(new Error('aborted')); });
      ws[rr++ % ws.length].postMessage({ id, z, x, y, az, alt, color, terrain, rings } satisfies ShadowRequest);
    });
  });
}

/** Tile URL template for a sun position, rounded so small time steps don't re-render everything. `b` = building-shadow version (0 = none). */
export function terrainShadowTiles(sun: { azimuth: number; altitude: number }, opts: { terrain?: boolean; b?: number } = {}): string[] {
  const az = ((Math.round(sun.azimuth) % 360) + 360) % 360;
  const alt = Math.round(sun.altitude * 2) / 2;
  return [`terrainshadow://{z}/{x}/{y}?az=${az}&alt=${alt}&t=${opts.terrain === false ? 0 : 1}&b=${opts.b ?? 0}`];
}

type St = { url: string; sun: { azimuth: number; altitude: number }; terrain: boolean; b: number; timer?: ReturnType<typeof setTimeout> };
const state = new WeakMap<MlMap, St>();
function st(map: MlMap): St {
  let s = state.get(map);
  if (!s) state.set(map, s = { url: '', sun: { azimuth: 180, altitude: 45 }, terrain: true, b: 0 });
  return s;
}
function apply(map: MlMap, s: St, now = false) {
  const tiles = terrainShadowTiles(s.sun, { terrain: s.terrain, b: s.b });
  if (tiles[0] === s.url) return;
  clearTimeout(s.timer);
  const first = !s.url;
  s.url = tiles[0];
  const go = () => { (map.getSource('terrain-shadow') as RasterTileSource | undefined)?.setTiles(tiles); };
  if (first || now) go(); else s.timer = setTimeout(go, 400);
}

/** Point the source at the new sun, debounced. */
export function setTerrainShadowSun(map: MlMap, sun: { azimuth: number; altitude: number }) {
  const s = st(map);
  s.sun = sun;
  apply(map, s);
}

/** Building shadows (lng/lat polygons) to rasterise into the mask; empty or null clears them. */
export function setBuildingShadows(map: MlMap, fc: GeoJSON.FeatureCollection | null) {
  const s = st(map);
  if (!fc?.features.length) { if (!s.b) return; buildings = { type: 'FeatureCollection', features: [] }; s.b = 0; }
  else { if (fc === buildings && s.b) return; buildings = fc; s.b = ++buildingsVer; }
  apply(map, s, true);
}

/** Whether the terrain part is drawn (the legend's Terrain toggle); buildings are switched by passing none. */
export function setTerrainShadowTerrain(map: MlMap, on: boolean) {
  const s = st(map);
  s.terrain = on;
  apply(map, s, true);
}

/** The `terrainshadow://` protocol: tiles rendered by Web Workers, keyed by the (rounded) sun in the URL. */
import { addProtocol, type Map as MlMap, type RasterTileSource } from 'maplibre-gl';
import type { ShadowRequest } from './terrainShadow.worker.js';

export const TERRAIN_SHADOW_MAX_DEM_Z = 12; // DEM sampled at <= z12; MapLibre overzooms above
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
    const u = /^terrainshadow:\/\/(\d+)\/(\d+)\/(\d+)\?az=([-\d.]+)&alt=([-\d.]+)/.exec(params.url);
    if (!u) return Promise.reject(new Error(`bad url ${params.url}`));
    const [z, x, y, az, alt] = u.slice(1).map(Number);
    const id = nextId++;
    const ws = pool();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (data) => resolve({ data }), reject });
      abort.signal.addEventListener('abort', () => { pending.delete(id); reject(new Error('aborted')); });
      ws[rr++ % ws.length].postMessage({ id, z, x, y, az, alt, color } satisfies ShadowRequest);
    });
  });
}

/** Tile URL template for a sun position, rounded so small time steps don't re-render everything. */
export function terrainShadowTiles(sun: { azimuth: number; altitude: number }): string[] {
  const az = ((Math.round(sun.azimuth) % 360) + 360) % 360;
  const alt = Math.round(sun.altitude * 2) / 2;
  return [`terrainshadow://{z}/{x}/{y}?az=${az}&alt=${alt}`];
}

const state = new WeakMap<MlMap, { url: string; timer?: ReturnType<typeof setTimeout> }>();
/** Point the source at the new sun, debounced. */
export function setTerrainShadowSun(map: MlMap, sun: { azimuth: number; altitude: number }) {
  const tiles = terrainShadowTiles(sun);
  const st = state.get(map) ?? { url: '' };
  state.set(map, st);
  if (tiles[0] === st.url) return;
  clearTimeout(st.timer);
  const first = !st.url;
  st.url = tiles[0];
  const apply = () => {
    (map.getSource('terrain-shadow') as RasterTileSource | undefined)?.setTiles(tiles);
  };
  if (first) apply(); else st.timer = setTimeout(apply, 250);
}

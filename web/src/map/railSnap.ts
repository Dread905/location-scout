/**
 * Client-side fallback for putting trains on the rails: where the server couldn't snap a train (no OSM track cached
 * for that area, Overpass down), snap it to the basemap's own rail lines — the vector tiles already carry them.
 * `RailSnapper` is pure (fed tiles' lines, asked to snap trains); `collectRailTiles` reads them from a MapLibre map.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { buildTrackGraph, clipLine, projectOnPath, snapToTrack, type TrackGraph } from './trackSnap.js';

type LngLat = [number, number];

/** Same slice lengths as the server (server/src/feeds/trains.ts PATH_BACK_KM / PATH_AHEAD_KM). */
export const PATH_BACK_KM = 0.6;
export const PATH_AHEAD_KM = 2.5;
/** Tile-edge line ends closer than this are joined. */
export const STITCH_KM = 0.001;
/** A new report within this of a trip's cached snapped path keeps using that path. */
const REUSE_OFF_KM = 0.015;

export interface TileBounds { west: number; south: number; east: number; north: number }

export function tileBounds(z: number, x: number, y: number): TileBounds {
  const n = 2 ** z;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

/** Build one graph from per-tile line sets: each clipped to its tile (dropping the buffer overlap), ends stitched. */
export function graphFromTiles(tiles: Iterable<{ bounds: TileBounds | null; lines: LngLat[][] }>): TrackGraph {
  const lines: { coords: LngLat[] }[] = [];
  for (const t of tiles) {
    for (const l of t.lines) {
      for (const piece of t.bounds ? clipLine(l, t.bounds) : [l]) lines.push({ coords: piece });
    }
  }
  return buildTrackGraph(lines, { mergeKm: STITCH_KM });
}

export interface SnappableTrain {
  tripId: string; lat: number; lng: number; bearing?: number | null;
  path?: LngLat[]; pathAtKm?: number; snapped?: boolean;
}

/** Keeps the basemap rail graph and each trip's last snapped path. */
export class RailSnapper {
  private tiles = new Map<string, { bounds: TileBounds | null; lines: LngLat[][] }>();
  private graph: TrackGraph | null = null;
  private byTrip = new Map<string, { path: LngLat[]; gen: number }>();
  /** Bumped when the graph changes, so trips that failed to snap are retried. */
  gen = 0;

  /** Replace the tile set; returns true when it changed (and the graph was rebuilt). */
  setTiles(tiles: Map<string, { bounds: TileBounds | null; lines: LngLat[][] }>): boolean {
    const same = tiles.size === this.tiles.size && [...tiles.keys()].every((k) => this.tiles.has(k));
    if (same) return false;
    this.tiles = tiles;
    this.graph = graphFromTiles(tiles.values());
    this.gen++;
    return true;
  }

  get hasTrack() { return (this.graph?.pts.length ?? 0) > 0; }

  /** Trains the server didn't snap, snapped onto the basemap rails where possible; others returned as-is. */
  snap<T extends SnappableTrain>(trains: T[]): T[] {
    const live = new Set<string>();
    const out = trains.map((t) => {
      live.add(t.tripId);
      if (t.snapped) return t;
      const lead: LngLat = [t.lng, t.lat];
      const cached = this.byTrip.get(t.tripId);
      if (cached) {
        const pr = projectOnPath(cached.path, lead);
        // Still on the cached path, far enough from its ends for the carriages and the run to the next poll.
        const end = pr ? cumKm(cached.path) : 0;
        if (pr && pr.offKm <= REUSE_OFF_KM && pr.atKm >= PATH_BACK_KM * 0.8 && end - pr.atKm >= 0.5) {
          return { ...t, ...onPath(cached.path, pr.atKm), path: cached.path, pathAtKm: pr.atKm, snapped: true };
        }
      }
      if (!this.graph || !this.hasTrack) return t;
      // The GTFS shape slice (unsnapped path) picks the branch at junctions; the lead is on it at pathAtKm.
      const shape = t.path && t.path.length >= 2 ? t.path : null;
      let bearing = t.bearing ?? null;
      if (shape && t.pathAtKm != null) bearing = onPath(shape, t.pathAtKm).bearing;
      const s = snapToTrack(this.graph, lead, { bearing, shape, backKm: PATH_BACK_KM, aheadKm: PATH_AHEAD_KM });
      if (!s) return t;
      this.byTrip.set(t.tripId, { path: s.path, gen: this.gen });
      return { ...t, lat: s.lat, lng: s.lng, bearing: s.bearing, path: s.path, pathAtKm: s.atKm, snapped: true };
    });
    for (const k of this.byTrip.keys()) if (!live.has(k)) this.byTrip.delete(k);
    return out;
  }
}

function cumKm(path: LngLat[]): number {
  return projectOnPath(path, path.at(-1)!)!.atKm;
}

/** Point and bearing `km` along a path (clamped to it). */
function onPath(path: LngLat[], km: number): { lat: number; lng: number; bearing: number } {
  let left = Math.max(0, km);
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    const [dx, dy] = [(b[0] - a[0]) * 111.32 * k, (b[1] - a[1]) * 111.32];
    const d = Math.hypot(dx, dy);
    if (d === 0) continue;
    const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    if (left <= d || i === path.length - 1) {
      const t = Math.min(1, left / d);
      return { lng: a[0] + t * (b[0] - a[0]), lat: a[1] + t * (b[1] - a[1]), bearing };
    }
    left -= d;
  }
  return { lng: path[0][0], lat: path[0][1], bearing: 0 };
}

const RAIL_CLASSES = ['rail', 'transit'];

/**
 * The basemap's rail lines, per loaded tile ("z/x/y"). OpenMapTiles-style sources: source-layer `transportation`,
 * class rail/transit (yards left out). Only the deepest zoom loaded is kept, so parent tiles' coarser copies of the
 * same line don't become parallel track. Tile ids come from MapLibre's feature internals (`_z/_x/_y`); without them
 * everything goes in one unclipped bucket (the stitching still joins what it can).
 */
export function collectRailTiles(map: MlMap): Map<string, { bounds: TileBounds | null; lines: LngLat[][] }> {
  const out = new Map<string, { z: number; bounds: TileBounds | null; lines: LngLat[][] }>();
  const style = map.getStyle?.();
  if (!style) return new Map();
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type !== 'vector') continue;
    let feats: ReturnType<MlMap['querySourceFeatures']>;
    try {
      feats = map.querySourceFeatures(id, { sourceLayer: 'transportation', filter: ['in', ['get', 'class'], ['literal', RAIL_CLASSES]] });
    } catch { continue; }
    for (const f of feats) {
      if (f.properties?.service === 'yard') continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates as LngLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LngLat[][]) : [];
      if (!lines.length) continue;
      const fi = f as unknown as { _z?: number; _x?: number; _y?: number };
      const known = Number.isInteger(fi._z) && Number.isInteger(fi._x) && Number.isInteger(fi._y);
      const key = known ? `${id}/${fi._z}/${fi._x}/${fi._y}` : `${id}/?`;
      const entry = out.get(key) ?? { z: known ? fi._z! : -1, bounds: known ? tileBounds(fi._z!, fi._x!, fi._y!) : null, lines: [] };
      entry.lines.push(...lines);
      out.set(key, entry);
    }
  }
  const maxZ = Math.max(-1, ...[...out.values()].map((e) => e.z));
  const res = new Map<string, { bounds: TileBounds | null; lines: LngLat[][] }>();
  for (const [k, e] of out) if (e.z === maxZ || maxZ === -1) res.set(k, { bounds: e.bounds, lines: e.lines });
  return res;
}

/**
 * Rail network layer: Overpass `railway=rail` ways in the configured areas,
 * plus industrial/mine sites near rail, refreshed weekly and cached as
 * GeoJSON in kv. Two separate Overpass queries (lines, then sites) rather
 * than one mixed `out geom`/`out center` query — simpler, and it's cached anyway.
 */
import { Db } from '../db.js';
import { Bbox, bboxFromRadius } from '../geo.js';
import { overpassQuery } from './overpass.js';
import type { TaskLog } from '../tasks/registry.js';
import { buildTrackGraph, nearestSegment, type TrackGraph } from '../feeds/trackSnap.js';

export const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const FETCH_TIMEOUT_MS = 25_000;
const RAIL_KV_KEY = 'rail:geojson';

interface OverpassWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
interface OverpassCenterWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}
type OverpassElement = OverpassWay | OverpassNode | OverpassCenterWay;

async function overpassFetch(query: string): Promise<{ elements: OverpassElement[] }> {
  return overpassQuery(query, { timeoutMs: FETCH_TIMEOUT_MS });
}

const bboxClause = (b: Bbox) => `${b.south},${b.west},${b.north},${b.east}`;

function railQuery(bboxes: Bbox[]): string {
  const ways = bboxes.map((b) => `way["railway"="rail"](${bboxClause(b)});`).join('\n');
  return `[out:json][timeout:60];(${ways});out geom;`;
}

function industrialQuery(bboxes: Bbox[]): string {
  const clauses = bboxes.flatMap((b) => [
    `node["landuse"="industrial"](${bboxClause(b)});`,
    `way["landuse"="industrial"](${bboxClause(b)});`,
    `node["industrial"="mine"](${bboxClause(b)});`,
    `way["industrial"="mine"](${bboxClause(b)});`,
    `node["man_made"="works"](${bboxClause(b)});`,
    `way["man_made"="works"](${bboxClause(b)});`,
  ]);
  return `[out:json][timeout:60];(${clauses.join('\n')});out center;`;
}

/** Pure: Overpass rail ways -> GeoJSON LineString features, deduped by way id. */
export function mapRailElements(elements: OverpassElement[]): GeoJSON.Feature[] {
  const seen = new Set<number>();
  const out: GeoJSON.Feature[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !('geometry' in el) || !el.geometry || seen.has(el.id)) continue;
    seen.add(el.id);
    const tags = el.tags ?? {};
    out.push({
      type: 'Feature',
      properties: { id: `way/${el.id}`, kind: 'rail', usage: tags.usage ?? '', service: tags.service ?? '', name: tags.name ?? '' },
      geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
    });
  }
  return out;
}

/** Pure: Overpass industrial/mine/works elements -> GeoJSON Point features, deduped by id. */
export function mapIndustrialElements(elements: OverpassElement[]): GeoJSON.Feature[] {
  const seen = new Set<string>();
  const out: GeoJSON.Feature[] = [];
  for (const el of elements) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    const tags = el.tags ?? {};
    const kind = tags.industrial === 'mine' ? 'mine' : tags.man_made === 'works' ? 'works' : 'industrial';
    let coords: [number, number] | null = null;
    if (el.type === 'node') coords = [el.lon, el.lat];
    else if ('center' in el && el.center) coords = [el.center.lon, el.center.lat];
    if (!coords) continue;
    seen.add(key);
    out.push({ type: 'Feature', properties: { id: key, kind, name: tags.name ?? '' }, geometry: { type: 'Point', coordinates: coords } });
  }
  return out;
}

export interface RailArea { lat: number; lng: number; radiusKm: number }

/** Fetch rail lines + industrial sites for every area, as one FeatureCollection. */
export async function fetchRailNetwork(areas: RailArea[]): Promise<GeoJSON.FeatureCollection> {
  const bboxes = areas.map((a) => bboxFromRadius(a.lat, a.lng, a.radiusKm));
  const [rail, industrial] = await Promise.all([
    overpassFetch(railQuery(bboxes)).then((r) => mapRailElements(r.elements)),
    overpassFetch(industrialQuery(bboxes)).then((r) => mapIndustrialElements(r.elements)),
  ]);
  return { type: 'FeatureCollection', features: [...rail, ...industrial] };
}

export function getCachedRail(db: Db): GeoJSON.FeatureCollection {
  const raw = db.getKv(RAIL_KV_KEY);
  return raw ? (JSON.parse(raw) as GeoJSON.FeatureCollection) : { type: 'FeatureCollection', features: [] };
}

/** Rail LineString features as the plain `{ref, coords}` shape freight.ts snaps/projects against. */
export function railLinesFromGeoJson(fc: GeoJSON.FeatureCollection): { ref: string; coords: [number, number][] }[] {
  return fc.features
    .filter((f): f is GeoJSON.Feature<GeoJSON.LineString> => f.geometry?.type === 'LineString')
    .map((f) => ({ ref: String(f.properties?.id ?? ''), coords: f.geometry.coordinates as [number, number][] }));
}

export async function runRailTask(db: Db, areas: RailArea[], log: TaskLog): Promise<{ ok: boolean; message: string }> {
  const fc = await fetchRailNetwork(areas);
  db.setKv(RAIL_KV_KEY, JSON.stringify(fc));
  const lines = fc.features.filter((f) => f.geometry?.type === 'LineString').length;
  const sites = fc.features.length - lines;
  log(`${lines} rail ways, ${sites} industrial/mine sites`);
  return { ok: true, message: `${lines} rail ways, ${sites} sites` };
}

// --- track graph for snapping trains ----------------------------------------------

/** On-demand rail tiles (degrees square) fetched around trains the weekly network doesn't cover. */
export const RAIL_TILE_DEG = 0.05;
const TILE_TTL_MS = 7 * 86_400_000;
const tileKey = (x: number, y: number) => `rail:tile:${x},${y}`;
export const railTileOf = (lng: number, lat: number): [number, number] => [Math.floor(lng / RAIL_TILE_DEG), Math.floor(lat / RAIL_TILE_DEG)];

let graphCache: { sig: string; graph: TrackGraph } | null = null;
const tilesKnown = new Set<string>();
const tilesInFlight = new Set<string>();
/** Tile key -> when a fetch last failed; not retried for TILE_RETRY_MS, and logged once per tile. */
const tilesFailed = new Map<string, number>();
const TILE_RETRY_MS = 10 * 60_000;

function tileLines(db: Db): { raw: string[]; keys: string[] } {
  const raw: string[] = []; const keys: string[] = [];
  for (const k of tilesKnown) { const v = db.getKv(k); if (v) { raw.push(v); keys.push(k); } }
  return { raw, keys };
}

type TileFetcher = (b: Bbox) => Promise<{ coords: [number, number][] }[]>;
const overpassTile: TileFetcher = async (b) =>
  railLinesFromGeoJson({ type: 'FeatureCollection', features: mapRailElements((await overpassFetch(railQuery([b]))).elements) });

/** Tiles covering a point and (when given) its whole path, so the consist behind a lead near a tile edge snaps too. */
function tilesFor(t: { lat: number; lng: number; path?: [number, number][] }): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const [lng, lat] of [[t.lng, t.lat] as [number, number], ...(t.path ?? [])]) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const xy = railTileOf(lng, lat);
    seen.set(`${xy[0]},${xy[1]}`, xy);
  }
  return [...seen.values()];
}

/** Fetch (in the background) any of these tiles not already cached, in flight, or recently failed. */
function requestTiles(db: Db, tiles: [number, number][], fetchTile: TileFetcher) {
  for (const [x, y] of tiles) {
    const k = tileKey(x, y);
    if (tilesInFlight.has(k)) continue;
    if (db.getKv(k) != null) { tilesKnown.add(k); continue; } // cached (maybe by an earlier run of the server)
    const failedAt = tilesFailed.get(k);
    if (failedAt != null && Date.now() - failedAt < TILE_RETRY_MS) continue;
    tilesInFlight.add(k);
    const b: Bbox = { west: x * RAIL_TILE_DEG, south: y * RAIL_TILE_DEG, east: (x + 1) * RAIL_TILE_DEG, north: (y + 1) * RAIL_TILE_DEG };
    fetchTile(b)
      .then((lines) => {
        db.setKv(k, JSON.stringify(lines.map((l) => ({ coords: l.coords }))), new Date(Date.now() + TILE_TTL_MS).toISOString());
        tilesKnown.add(k); tilesFailed.delete(k);
      })
      .catch((err: unknown) => {
        if (!tilesFailed.has(k)) console.warn(`[rail] track tile ${k} fetch failed (retrying in ${TILE_RETRY_MS / 60_000} min): ${err instanceof Error ? err.message : String(err)}`);
        tilesFailed.set(k, Date.now());
      })
      .finally(() => tilesInFlight.delete(k));
  }
}

/**
 * The track graph for snapping trains: the cached weekly network plus any on-demand tiles. Trains with no track
 * nearby (outside the configured areas) get their tiles fetched in the background, so the next poll can snap them —
 * independent of whether the Rail overlay is shown. `fetchTile` is injectable for tests.
 */
export function trackGraphFor(
  db: Db, trains: { lat: number; lng: number; path?: [number, number][] }[], fetchTile: TileFetcher = overpassTile,
): TrackGraph {
  const base = db.getKv(RAIL_KV_KEY) ?? '';
  const tiles = tileLines(db);
  const sig = `${base.length}:${base.slice(0, 64)}|${tiles.keys.join(';')}`;
  if (!graphCache || graphCache.sig !== sig) {
    const lines = [
      ...railLinesFromGeoJson(getCachedRail(db)),
      ...tiles.raw.flatMap((r) => JSON.parse(r) as { coords: [number, number][] }[]),
    ];
    graphCache = { sig, graph: buildTrackGraph(lines) };
  }
  const graph = graphCache.graph;
  for (const t of trains) {
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng) || nearestSegment(graph, [t.lng, t.lat], 0.2)) continue;
    requestTiles(db, tilesFor(t), fetchTile);
  }
  return graph;
}

/**
 * Trains that didn't snap despite some track nearby (a partial network: another tile's line, only the base area's
 * edge): fetch every tile under the lead and its path. Before, a tile was only fetched when *nothing* lay within
 * 200 m, so at a busy spot like Strathfield a neighbouring tile's track kept the train's own tile from ever loading.
 */
export function requestTilesForUnsnapped(db: Db, trains: { lat: number; lng: number; path?: [number, number][]; snapped?: boolean }[], fetchTile: TileFetcher = overpassTile) {
  for (const t of trains) if (!t.snapped) requestTiles(db, tilesFor(t), fetchTile);
}

/** Forget the in-memory graph and known tiles (tests). */
export function resetTrackGraphCache() { graphCache = null; tilesKnown.clear(); tilesInFlight.clear(); tilesFailed.clear(); }

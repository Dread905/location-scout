/**
 * Rail network layer: Overpass `railway=rail` ways in the configured areas,
 * plus industrial/mine sites near rail, refreshed weekly and cached as
 * GeoJSON in kv. Two separate Overpass queries (lines, then sites) rather
 * than one mixed `out geom`/`out center` query — simpler, and it's cached anyway.
 */
import { Db } from '../db.js';
import { Bbox, bboxFromRadius } from '../geo.js';
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
    return (await res.json()) as { elements: OverpassElement[] };
  } finally {
    clearTimeout(timer);
  }
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

function tileLines(db: Db): { raw: string[]; keys: string[] } {
  const raw: string[] = []; const keys: string[] = [];
  for (const k of tilesKnown) { const v = db.getKv(k); if (v) { raw.push(v); keys.push(k); } }
  return { raw, keys };
}

/**
 * The track graph for snapping trains: the cached weekly network plus any on-demand tiles. Trains with no track
 * nearby (outside the configured areas) get their tile fetched in the background, so the next poll can snap them —
 * independent of whether the Rail overlay is shown. `fetchTile` is injectable for tests.
 */
export function trackGraphFor(
  db: Db, trains: { lat: number; lng: number }[],
  fetchTile: (b: Bbox) => Promise<{ coords: [number, number][] }[]> = async (b) =>
    railLinesFromGeoJson({ type: 'FeatureCollection', features: mapRailElements((await overpassFetch(railQuery([b]))).elements) }),
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
    const [x, y] = railTileOf(t.lng, t.lat);
    const k = tileKey(x, y);
    if (tilesInFlight.has(k) || (tilesKnown.has(k) && db.getKv(k) != null)) continue;
    if (db.getKv(k) != null) { tilesKnown.add(k); continue; } // fetched by an earlier run of the server
    tilesInFlight.add(k);
    const b: Bbox = { west: x * RAIL_TILE_DEG, south: y * RAIL_TILE_DEG, east: (x + 1) * RAIL_TILE_DEG, north: (y + 1) * RAIL_TILE_DEG };
    fetchTile(b)
      .then((lines) => { db.setKv(k, JSON.stringify(lines.map((l) => ({ coords: l.coords }))), new Date(Date.now() + TILE_TTL_MS).toISOString()); tilesKnown.add(k); })
      .catch(() => { /* try again on a later poll */ })
      .finally(() => tilesInFlight.delete(k));
  }
  return graph;
}

/** Forget the in-memory graph and known tiles (tests). */
export function resetTrackGraphCache() { graphCache = null; tilesKnown.clear(); tilesInFlight.clear(); }

/**
 * Rail network layer: Overpass `railway=rail` ways in the configured areas,
 * plus industrial/mine sites near rail, refreshed weekly and cached as
 * GeoJSON in kv. Two separate Overpass queries (lines, then sites) rather
 * than one mixed `out geom`/`out center` query — simpler, and it's cached anyway.
 *
 * Uses resilient, sequential Overpass client with area tiling, deduplication,
 * and last-known-good cache preservation.
 */
import { Db } from '../db.js';
import { Bbox, tileArea } from '../geo.js';
import { DEFAULT_OVERPASS_ENDPOINT, OverpassClient, OverpassError } from './overpass.js';
import type { TaskLog } from '../tasks/registry.js';

export const OVERPASS_URL = process.env.OVERPASS_URL ?? DEFAULT_OVERPASS_ENDPOINT;
const RAIL_KV_KEY = 'rail:geojson';

export interface OverpassWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
export interface OverpassCenterWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}
export type OverpassElement = OverpassWay | OverpassNode | OverpassCenterWay;

const bboxClause = (b: Bbox) => `${b.south},${b.west},${b.north},${b.east}`;

export function railQuery(bboxes: Bbox[]): string {
  const ways = bboxes.map((b) => `way["railway"="rail"](${bboxClause(b)});`).join('\n');
  return `[out:json][timeout:60];(${ways});out geom;`;
}

export function industrialQuery(bboxes: Bbox[]): string {
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

export interface FetchRailNetworkOptions {
  client?: OverpassClient;
  maxTileKm?: number;
}

/**
 * Fetch rail lines + industrial sites for every area, as one FeatureCollection.
 * - Slices large areas into bounded sequential tiles.
 * - Processes rail lines and industrial sites serially.
 * - Deduplicates features across tiles.
 */
export async function fetchRailNetwork(
  areas: RailArea[],
  options: FetchRailNetworkOptions = {}
): Promise<GeoJSON.FeatureCollection> {
  const client = options.client ?? new OverpassClient();
  const maxTileKm = options.maxTileKm;
  const tiles: Bbox[] = areas.flatMap((a) => tileArea(a.lat, a.lng, a.radiusKm, maxTileKm));

  const railElements: OverpassElement[] = [];
  const seenWayIds = new Set<number>();

  // Fetch rail lines serially per tile
  for (const tile of tiles) {
    const ql = railQuery([tile]);
    const res = await client.query<OverpassElement>(ql, { category: 'rail' });
    for (const el of res.elements) {
      if (el.type === 'way' && !seenWayIds.has(el.id)) {
        seenWayIds.add(el.id);
        railElements.push(el);
      }
    }
  }

  const industrialElements: OverpassElement[] = [];
  const seenSiteKeys = new Set<string>();

  // Fetch industrial/mine sites serially per tile
  for (const tile of tiles) {
    const ql = industrialQuery([tile]);
    const res = await client.query<OverpassElement>(ql, { category: 'industrial' });
    for (const el of res.elements) {
      const key = `${el.type}/${el.id}`;
      if (!seenSiteKeys.has(key)) {
        seenSiteKeys.add(key);
        industrialElements.push(el);
      }
    }
  }

  const railFeatures = mapRailElements(railElements);
  const industrialFeatures = mapIndustrialElements(industrialElements);
  return { type: 'FeatureCollection', features: [...railFeatures, ...industrialFeatures] };
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

export interface RunRailTaskOptions {
  client?: OverpassClient;
  maxTileKm?: number;
}

export async function runRailTask(
  db: Db,
  areas: RailArea[],
  log: TaskLog,
  options: RunRailTaskOptions = {}
): Promise<{ ok: boolean; message: string }> {
  try {
    const fc = await fetchRailNetwork(areas, {
      client: options.client,
      maxTileKm: options.maxTileKm,
    });
    db.setKv(RAIL_KV_KEY, JSON.stringify(fc));
    const lines = fc.features.filter((f) => f.geometry?.type === 'LineString').length;
    const sites = fc.features.length - lines;
    log(`${lines} rail ways, ${sites} industrial/mine sites`);
    return { ok: true, message: `${lines} rail ways, ${sites} sites` };
  } catch (err) {
    // Preserve existing cached rail GeoJSON: do not overwrite RAIL_KV_KEY
    const message = (err as Error).message;
    log(`rail network task failed: ${message}`);
    return { ok: false, message };
  }
}

/**
 * OSM Overpass candidates: viewpoints, ruins, disused/abandoned features,
 * lighthouses/silos/water towers, disused stations. Refreshed weekly, upserted
 * into the `candidates` table by source+ref, promoted to a spot on request.
 */
import crypto from 'node:crypto';
import { Db } from '../db.js';
import { Bbox, bboxFromRadius } from '../geo.js';
import { OVERPASS_URL } from './rail.js';
import type { TaskLog } from '../tasks/registry.js';
import type { RailArea } from './rail.js';

const FETCH_TIMEOUT_MS = 25_000;

interface OverpassCandidateElement {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function bboxClause(b: Bbox): string {
  return `${b.south},${b.west},${b.north},${b.east}`;
}

function candidatesQuery(bboxes: Bbox[]): string {
  const clauses = bboxes.flatMap((b) => {
    const bc = bboxClause(b);
    return [
      `node["tourism"="viewpoint"](${bc});`,
      `way["tourism"="viewpoint"](${bc});`,
      `node["historic"="ruins"](${bc});`,
      `way["historic"="ruins"](${bc});`,
      `node["man_made"~"^(lighthouse|silo|water_tower)$"](${bc});`,
      `way["man_made"~"^(lighthouse|silo|water_tower)$"](${bc});`,
      `node["railway"="station"]["disused"](${bc});`,
      `way["railway"="station"]["disused"](${bc});`,
      `node["railway"="station"]["abandoned"](${bc});`,
      `way["railway"="station"]["abandoned"](${bc});`,
      `node[~"^(abandoned|disused):"~"."](${bc});`,
      `way[~"^(abandoned|disused):"~"."](${bc});`,
    ];
  });
  return `[out:json][timeout:60];(${clauses.join('\n')});out center tags;`;
}

async function overpassFetch(query: string): Promise<{ elements: OverpassCandidateElement[] }> {
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
    return (await res.json()) as { elements: OverpassCandidateElement[] };
  } finally {
    clearTimeout(timer);
  }
}

export interface CandidateRow { ref: string; name: string; lat: number; lng: number; tags: Record<string, string> }

/** Pure: Overpass elements -> candidate rows, deduped by ref. */
export function mapCandidateElements(elements: OverpassCandidateElement[]): CandidateRow[] {
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const el of elements) {
    const ref = `${el.type}/${el.id}`;
    if (seen.has(ref)) continue;
    const coords = el.type === 'node' ? { lat: el.lat, lng: el.lon } : el.center ? { lat: el.center.lat, lng: el.center.lon } : null;
    if (!coords || coords.lat == null || coords.lng == null) continue;
    seen.add(ref);
    const tags = el.tags ?? {};
    out.push({ ref, name: tags.name ?? '', lat: coords.lat, lng: coords.lng, tags });
  }
  return out;
}

export async function fetchCandidates(areas: RailArea[]): Promise<CandidateRow[]> {
  const bboxes = areas.map((a) => bboxFromRadius(a.lat, a.lng, a.radiusKm));
  const { elements } = await overpassFetch(candidatesQuery(bboxes));
  return mapCandidateElements(elements);
}

export async function runCandidatesTask(db: Db, areas: RailArea[], log: TaskLog): Promise<{ ok: boolean; message: string }> {
  const rows = await fetchCandidates(areas);
  const now = new Date().toISOString();
  for (const r of rows) {
    db.handle
      .prepare(
        `INSERT INTO candidates (id, source, ref, name, lat, lng, tags, fetched_at) VALUES (?, 'osm', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, ref) DO UPDATE SET name=excluded.name, lat=excluded.lat, lng=excluded.lng, tags=excluded.tags, fetched_at=excluded.fetched_at`
      )
      .run(crypto.randomUUID(), r.ref, r.name, r.lat, r.lng, JSON.stringify(r.tags), now);
  }
  log(`${rows.length} candidates upserted`);
  return { ok: true, message: `${rows.length} candidates` };
}

// --- building footprints (Plan shoot's building shadows) ------------------------------

interface OverpassBuildingWay { type: 'way'; id: number; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }
export const BUILDING_LEVEL_M = 3;
export interface BuildingFeature { type: 'Feature'; id: number; properties: { height?: number }; geometry: { type: 'Polygon'; coordinates: number[][][] } }
export interface BuildingCollection { type: 'FeatureCollection'; features: BuildingFeature[] }

/** Overpass `out geom` building ways to GeoJSON footprints with a numeric `height` (tag, else levels × 3 m, else none). */
export function buildingsFromOverpass(elements: OverpassBuildingWay[]): BuildingCollection {
  const features: BuildingFeature[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
    const ring = el.geometry.map((p) => [p.lon, p.lat]);
    const [a, b] = [ring[0], ring[ring.length - 1]];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
    const t = el.tags ?? {};
    const h = parseFloat(t.height ?? '');
    const levels = parseFloat(t['building:levels'] ?? '');
    const height = Number.isFinite(h) ? h : Number.isFinite(levels) ? levels * BUILDING_LEVEL_M : undefined;
    features.push({ type: 'Feature', id: el.id, properties: height != null ? { height } : {}, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  return { type: 'FeatureCollection', features };
}

/** Building footprints within `radiusM` of a point, from Overpass. */
export async function fetchBuildings(lat: number, lng: number, radiusM: number): Promise<BuildingCollection> {
  const r = Math.round(Math.min(1000, Math.max(50, radiusM)));
  const q = `[out:json][timeout:20];way["building"](around:${r},${lat},${lng});out geom tags;`;
  const data = await overpassFetch(q) as unknown as { elements: OverpassBuildingWay[] };
  return buildingsFromOverpass(data.elements);
}

/**
 * OSM Overpass candidates: viewpoints, ruins, disused/abandoned features,
 * lighthouses/silos/water towers, disused stations. Refreshed weekly, upserted
 * into the `candidates` table by source+ref, promoted to a spot on request.
 *
 * Uses resilient, sequential Overpass client with area tiling, category splitting,
 * and failure isolation.
 */
import crypto from 'node:crypto';
import { Db } from '../db.js';
import { Bbox, tileArea } from '../geo.js';
import { OverpassClient, OverpassError } from './overpass.js';
import type { TaskLog } from '../tasks/registry.js';
import type { RailArea } from './rail.js';

export const CANDIDATE_CATEGORIES = [
  'viewpoints',
  'ruins',
  'landmarks',
  'disused_stations',
  'abandoned_disused',
] as const;

export type CandidateCategory = typeof CANDIDATE_CATEGORIES[number];

export interface OverpassCandidateElement {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface CandidateRow {
  ref: string;
  name: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

function bboxClause(b: Bbox): string {
  return `${b.south},${b.west},${b.north},${b.east}`;
}

export function candidateCategoryQuery(category: CandidateCategory, bbox: Bbox): string {
  const bc = bboxClause(bbox);
  let clauses: string[] = [];

  switch (category) {
    case 'viewpoints':
      clauses = [
        `node["tourism"="viewpoint"](${bc});`,
        `way["tourism"="viewpoint"](${bc});`,
      ];
      break;
    case 'ruins':
      clauses = [
        `node["historic"="ruins"](${bc});`,
        `way["historic"="ruins"](${bc});`,
      ];
      break;
    case 'landmarks':
      clauses = [
        `node["man_made"~"^(lighthouse|silo|water_tower)$"](${bc});`,
        `way["man_made"~"^(lighthouse|silo|water_tower)$"](${bc});`,
      ];
      break;
    case 'disused_stations':
      clauses = [
        `node["railway"="station"]["disused"](${bc});`,
        `way["railway"="station"]["disused"](${bc});`,
        `node["railway"="station"]["abandoned"](${bc});`,
        `way["railway"="station"]["abandoned"](${bc});`,
      ];
      break;
    case 'abandoned_disused':
      clauses = [
        `node[~"^(abandoned|disused):"~"."](${bc});`,
        `way[~"^(abandoned|disused):"~"."](${bc});`,
      ];
      break;
  }

  return `[out:json][timeout:60];(${clauses.join('\n')});out center tags;`;
}

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

export interface FetchCandidatesOptions {
  client?: OverpassClient;
  maxTileKm?: number;
  log?: TaskLog;
  onCategoryError?: (category: CandidateCategory, error: Error) => void;
}

/**
 * Fetches candidates across configured areas.
 * - Subdivides areas into bounded sequential tiles.
 * - Queries each semantic category serially.
 * - Deduplicates elements across tiles and categories.
 * - Isolates category errors so one failing category does not discard other results.
 */
export async function fetchCandidates(
  areas: RailArea[],
  options: FetchCandidatesOptions = {}
): Promise<CandidateRow[]> {
  const client = options.client ?? new OverpassClient();
  const maxTileKm = options.maxTileKm;
  const tiles: Bbox[] = areas.flatMap((a) => tileArea(a.lat, a.lng, a.radiusKm, maxTileKm));

  const seenRefs = new Set<string>();
  const rows: CandidateRow[] = [];

  for (const cat of CANDIDATE_CATEGORIES) {
    for (const tile of tiles) {
      try {
        const ql = candidateCategoryQuery(cat, tile);
        const res = await client.query<OverpassCandidateElement>(ql, { category: cat });
        const batch = mapCandidateElements(res.elements);
        for (const item of batch) {
          if (!seenRefs.has(item.ref)) {
            seenRefs.add(item.ref);
            rows.push(item);
          }
        }
      } catch (err) {
        if (options.onCategoryError) {
          options.onCategoryError(cat, err as Error);
        }
        // Break out of the remaining tiles for this failing category to avoid wasteful requests
        break;
      }
    }
  }

  return rows;
}

export interface RunCandidatesTaskOptions {
  client?: OverpassClient;
  maxTileKm?: number;
}

export async function runCandidatesTask(
  db: Db,
  areas: RailArea[],
  log: TaskLog,
  options: RunCandidatesTaskOptions = {}
): Promise<{ ok: boolean; message: string }> {
  const failedCategories: { category: CandidateCategory; error: Error }[] = [];

  const rows = await fetchCandidates(areas, {
    client: options.client,
    maxTileKm: options.maxTileKm,
    log,
    onCategoryError: (category, error) => {
      failedCategories.push({ category, error });
      log(`category ${category} failed: ${error.message}`);
    },
  });

  // Upsert all discovered candidate rows; pre-existing rows in DB are preserved
  const now = new Date().toISOString();
  if (rows.length > 0) {
    const stmt = db.handle.prepare(
      `INSERT INTO candidates (id, source, ref, name, lat, lng, tags, fetched_at) VALUES (?, 'osm', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, ref) DO UPDATE SET name=excluded.name, lat=excluded.lat, lng=excluded.lng, tags=excluded.tags, fetched_at=excluded.fetched_at`
    );
    for (const r of rows) {
      stmt.run(crypto.randomUUID(), r.ref, r.name, r.lat, r.lng, JSON.stringify(r.tags), now);
    }
  }

  if (failedCategories.length > 0) {
    const catNames = failedCategories.map((f) => f.category).join(', ');
    const primaryError = failedCategories[0].error;
    const msg = `${rows.length} candidates upserted; category ${catNames} failed: ${primaryError.message}`;
    log(msg);
    return { ok: false, message: msg };
  }

  log(`${rows.length} candidates upserted`);
  return { ok: true, message: `${rows.length} candidates` };
}

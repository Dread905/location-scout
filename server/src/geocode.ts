import { Db } from './db.js';

const USER_AGENT = 'location-scout/0.1 (local personal app)';

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
  kind?: string;
}

interface CacheEntry {
  at: number;
  results: GeocodeResult[];
}

const EMPTY_TTL_MS = 7 * 24 * 3600_000;
const RESULT_TTL_MS = 180 * 24 * 3600_000;

const cacheKeyFor = (query: string): string => `geocode:${query.toLowerCase().trim()}`;

function readEntry(db: Db, query: string): CacheEntry | null {
  const raw = db.getKv(cacheKeyFor(query));
  if (!raw) return null;
  return JSON.parse(raw) as CacheEntry;
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.results.length === 0 ? EMPTY_TTL_MS : RESULT_TTL_MS;
  return Date.now() - entry.at < ttl;
}

/**
 * Nominatim's one-request-a-second rule, enforced once for the whole process.
 * ponytail: a process-wide lock, not per-key — fine at Nominatim's own limit.
 */
let nominatimQueue: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  const wait = nominatimQueue.then(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  nominatimQueue = wait;
  return wait;
}

export async function geocode(db: Db, query: string): Promise<GeocodeResult[]> {
  const cacheKey = cacheKeyFor(query);
  const entry = readEntry(db, query);
  if (entry && isFresh(entry)) return entry.results;

  await throttle();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const data = (await res.json()) as
    { display_name: string; lat: string; lon: string; class?: string; type?: string }[];
  const results = data.map((r) => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    kind: `${r.class ?? ''}:${r.type ?? ''}`,
  }));
  db.setKv(cacheKey, JSON.stringify({ at: Date.now(), results }));
  return results;
}

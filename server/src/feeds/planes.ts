/** adsb.lol (or airplanes.live, same API) point search, plus dead-reckoning. On-demand only, no background polling. */

export interface Plane {
  hex: string;
  flight: string;
  lat: number;
  lon: number;
  track: number | null;
  gs: number | null; // knots
  alt_baro: number | null;
  t: string; // aircraft type
  seen: number; // seconds since last message
}

interface AdsbAircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  track?: number;
  gs?: number;
  alt_baro?: number | 'ground';
  t?: string;
  seen?: number;
}

function toPlane(a: AdsbAircraft): Plane | null {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
  return {
    hex: a.hex,
    flight: (a.flight ?? '').trim(),
    lat: a.lat,
    lon: a.lon,
    track: typeof a.track === 'number' ? a.track : null,
    gs: typeof a.gs === 'number' ? a.gs : null,
    alt_baro: a.alt_baro === 'ground' ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null,
    t: a.t ?? '',
    seen: a.seen ?? 0,
  };
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; planes: Plane[] }>();

const GRID_DEG = 0.25; // ~25km: requests snap to this grid so panning reuses one upstream call
const MIN_GAP_MS = 5_000; // never hit upstream more often than this, whatever the key
let lastFetchAt = 0;
let backoffUntil = 0;
const inflight = new Map<string, Promise<Plane[]>>();

const snap = (v: number) => Math.round(v / GRID_DEG) * GRID_DEG;

/** Snapped to the grid, with the radius padded so the snapped circle still covers the asked-for one. */
function cacheKey(lat: number, lng: number, nm: number): string {
  return `${snap(lat).toFixed(2)},${snap(lng).toFixed(2)},${Math.ceil((nm + 12) / 10) * 10}`;
}

/** Nearest cached result, however old — served while rate-limited or backing off rather than erroring. */
function stale(key: string): Plane[] {
  return cache.get(key)?.planes ?? [...cache.values()].sort((a, b) => b.at - a.at)[0]?.planes ?? [];
}

export async function fetchPlanes(baseUrl: string, lat: number, lng: number, nm: number): Promise<Plane[]> {
  const key = cacheKey(lat, lng, nm);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.planes;
  if (now < backoffUntil || now - lastFetchAt < MIN_GAP_MS) return stale(key);
  const pending = inflight.get(key);
  if (pending) return pending;

  const [sLat, sLng, sNm] = key.split(',').map(Number);
  lastFetchAt = now;
  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v2/point/${sLat}/${sLng}/${sNm}`;
      // adsb.lol 403s a request with no User-Agent at all (Node's fetch sends none by default).
      const res = await fetch(url, { headers: { 'User-Agent': 'location-scout/0.1 (local personal app)' }, signal: controller.signal });
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        backoffUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000);
        return stale(key);
      }
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      const data = (await res.json()) as { ac?: AdsbAircraft[] };
      const planes = (data.ac ?? []).map(toPlane).filter((pl): pl is Plane => pl !== null);
      cache.set(key, { at: Date.now(), planes });
      return planes;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const KNOTS_TO_KMH = 1.852;
const EARTH_KM = 6371;

/** Great-circle projection along track and ground speed, `minutes` ahead. Null if track/speed are unknown. */
export function deadReckon(plane: Pick<Plane, 'lat' | 'lon' | 'track' | 'gs'>, minutes: number): { lat: number; lon: number } | null {
  if (plane.track == null || plane.gs == null) return null;
  const km = (plane.gs * KNOTS_TO_KMH * minutes) / 60;
  const d = km / EARTH_KM;
  const brg = (plane.track * Math.PI) / 180;
  const la1 = (plane.lat * Math.PI) / 180;
  const lo1 = (plane.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
  const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (((lo2 * 180) / Math.PI + 540) % 360) - 180 };
}

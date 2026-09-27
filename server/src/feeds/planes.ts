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
    alt_baro: typeof a.alt_baro === 'number' ? a.alt_baro : null,
    t: a.t ?? '',
    seen: a.seen ?? 0,
  };
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; planes: Plane[] }>();

/** Rounded to ~1km so nearby requests share a cache entry. */
function cacheKey(lat: number, lng: number, nm: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${Math.round(nm)}`;
}

export async function fetchPlanes(baseUrl: string, lat: number, lng: number, nm: number): Promise<Plane[]> {
  const key = cacheKey(lat, lng, nm);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.planes;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/v2/point/${lat}/${lng}/${Math.round(nm)}`;
    // adsb.lol 403s a request with no User-Agent at all (Node's fetch sends none by default).
    const res = await fetch(url, { headers: { 'User-Agent': 'location-scout/0.1 (local personal app)' }, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const data = (await res.json()) as { ac?: AdsbAircraft[] };
    const planes = (data.ac ?? []).map(toPlane).filter((p): p is Plane => p !== null);
    cache.set(key, { at: Date.now(), planes });
    return planes;
  } finally {
    clearTimeout(timer);
  }
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

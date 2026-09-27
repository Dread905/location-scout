/** Open-Meteo hourly forecast (free, no key). Cached per 0.05° cell for 20 min, stale-on-error. */

export interface WeatherHour {
  time: string; // ISO (UTC)
  tempC: number | null;
  cloudPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipMm: number | null;
  precipProbPct: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  visibilityM: number | null;
  weatherCode: number | null;
  fogLikely: boolean;
}

export interface WeatherForecast {
  lat: number;
  lng: number;
  fetchedAt: string;
  hourly: WeatherHour[];
}

const HOURLY_VARS = [
  'temperature_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation',
  'precipitation_probability', 'wind_speed_10m', 'wind_gusts_10m', 'visibility', 'weather_code',
] as const;

type Hourly = Partial<Record<(typeof HOURLY_VARS)[number], (number | null)[]>> & { time?: (string | number)[] };

/** Fog: WMO codes 45/48, or visibility under 1 km, or near-saturated low cloud with calm wind is not enough on its own. */
export function isFogLikely(h: { visibilityM: number | null; weatherCode: number | null }): boolean {
  if (h.weatherCode === 45 || h.weatherCode === 48) return true;
  return h.visibilityM != null && h.visibilityM < 1000;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse an Open-Meteo response requested with timeformat=unixtime (or ISO GMT strings). */
export function parseOpenMeteo(data: { hourly?: Hourly }, lat: number, lng: number, fetchedAt = new Date()): WeatherForecast {
  const h = data.hourly ?? {};
  const times = h.time ?? [];
  const at = (k: (typeof HOURLY_VARS)[number], i: number) => num(h[k]?.[i]);
  const hourly: WeatherHour[] = [];
  times.forEach((t, i) => {
    const d = typeof t === 'number' ? new Date(t * 1000) : new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
    if (Number.isNaN(d.getTime())) return;
    const visibilityM = at('visibility', i);
    const weatherCode = at('weather_code', i);
    hourly.push({
      time: d.toISOString(),
      tempC: at('temperature_2m', i),
      cloudPct: at('cloud_cover', i),
      cloudLowPct: at('cloud_cover_low', i),
      cloudMidPct: at('cloud_cover_mid', i),
      cloudHighPct: at('cloud_cover_high', i),
      precipMm: at('precipitation', i),
      precipProbPct: at('precipitation_probability', i),
      windKmh: at('wind_speed_10m', i),
      gustKmh: at('wind_gusts_10m', i),
      visibilityM,
      weatherCode,
      fogLikely: isFogLikely({ visibilityM, weatherCode }),
    });
  });
  return { lat, lng, fetchedAt: fetchedAt.toISOString(), hourly };
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 20 * 60_000;
const GRID_DEG = 0.05;
const cache = new Map<string, { at: number; data: WeatherForecast }>();
const inflight = new Map<string, Promise<WeatherForecast>>();
const snap = (v: number) => Math.round(v / GRID_DEG) * GRID_DEG;

export async function fetchWeather(baseUrl: string, lat: number, lng: number, days = 7): Promise<WeatherForecast> {
  const d = Math.min(16, Math.max(1, Math.round(days)));
  const sLat = Number(snap(lat).toFixed(2));
  const sLng = Number(snap(lng).toFixed(2));
  const key = `${sLat},${sLng},${d}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1/forecast?latitude=${sLat}&longitude=${sLng}&hourly=${HOURLY_VARS.join(',')}`
        + `&wind_speed_unit=kmh&timeformat=unixtime&timezone=GMT&forecast_days=${d}&past_days=1`;
      const res = await fetch(url, { headers: { 'User-Agent': 'location-scout/0.1 (local personal app)' }, signal: controller.signal });
      if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
      const data = parseOpenMeteo((await res.json()) as { hourly?: Hourly }, sLat, sLng);
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch (err) {
      if (hit) return hit.data; // stale beats nothing
      throw err;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

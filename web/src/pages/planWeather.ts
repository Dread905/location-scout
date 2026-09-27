/** Weather for Plan shoot: api.weather (Open-Meteo via GET /api/weather), with missing values filled so scoring stays numeric. */
import { api, type WeatherHour as ApiWeatherHour } from '../api.js';
import type { WeatherHour, WeatherResponse } from '../map/recommend.js';

const FILL: Omit<WeatherHour, 'time' | 'fogLikely'> = {
  tempC: 0, cloudPct: 0, cloudLowPct: 0, cloudMidPct: 0, cloudHighPct: 0, precipMm: 0, precipProbPct: 0, windKmh: 0, gustKmh: 0, visibilityM: 20_000, weatherCode: 0,
};

export function normaliseHour(h: ApiWeatherHour): WeatherHour {
  const out = { time: h.time, fogLikely: !!h.fogLikely } as WeatherHour;
  for (const k of Object.keys(FILL) as (keyof typeof FILL)[]) out[k] = h[k] ?? FILL[k];
  if (h.gustKmh == null) out.gustKmh = out.windKmh;
  return out;
}

export async function fetchWeather(lat: number, lng: number, days = 7): Promise<WeatherResponse> {
  const w = await api.weather(lat, lng, days);
  return { ...w, hourly: w.hourly.map(normaliseHour) };
}

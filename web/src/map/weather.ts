/** Weather overlay helpers: RainViewer radar frame choice and the map-centre readout. Pure, no MapLibre. */
import type { WeatherForecast, WeatherHour } from '../api.js';

export const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
export const RADAR_MAX_NATIVE_Z = 7;

export interface RadarIndex { host: string; radar: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } }
export interface RadarFrame { time: number; path: string; nowcast: boolean }

/** Frame to show at `t` (ms): the latest frame at or before t, if t lies within the frames' span (+10 min past the last). */
export function pickRadarFrame(idx: RadarIndex, t: number): RadarFrame | null {
  const frames: RadarFrame[] = [
    ...(idx.radar.past ?? []).map((f) => ({ ...f, nowcast: false })),
    ...(idx.radar.nowcast ?? []).map((f) => ({ ...f, nowcast: true })),
  ].sort((a, b) => a.time - b.time);
  if (!frames.length) return null;
  const s = t / 1000;
  if (s < frames[0].time - 300 || s > frames[frames.length - 1].time + 600) return null;
  let best = frames[0];
  for (const f of frames) if (f.time <= s) best = f;
  return best;
}

export const radarTileUrl = (host: string, frame: RadarFrame) => `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;

/** The forecast hour containing `t` (nearest within 90 min), else null. */
export function hourAt(f: WeatherForecast | null, t: number): WeatherHour | null {
  if (!f) return null;
  let best: WeatherHour | null = null;
  let bestD = Infinity;
  for (const h of f.hourly) {
    const d = Math.abs(Date.parse(h.time) + 30 * 60_000 - t);
    if (d < bestD) { bestD = d; best = h; }
  }
  return bestD <= 90 * 60_000 ? best : null;
}

/** Emoji for a WMO weather code (with fog override). */
export function weatherIcon(h: Pick<WeatherHour, 'weatherCode' | 'fogLikely' | 'cloudPct'>, night = false): string {
  const c = h.weatherCode;
  if (h.fogLikely) return '🌫';
  if (c == null) return (h.cloudPct ?? 0) > 70 ? '☁️' : night ? '🌙' : '☀️';
  if (c >= 95) return '⛈';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '🌨';
  if (c >= 51) return '🌧';
  if (c === 3) return '☁️';
  if (c === 2) return night ? '☁️' : '⛅';
  if (c === 1) return night ? '🌙' : '🌤';
  return night ? '🌙' : '☀️';
}

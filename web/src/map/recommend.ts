/**
 * Plan shoot recommender: score every slot across a date range against what the photographer is after
 * (light, weather, trains), then pick the best few distinct times with plain-language reasons. Pure.
 */
import type { Phase } from './sun.js';
import type { Light } from './shootPlan.js';
import { haversineKm } from './geo.js';

export type Criterion = 'golden' | 'blue' | 'sun' | 'shade' | 'align' | 'clear' | 'drama' | 'fog' | 'dry' | 'calm' | 'train' | 'planes';

export const CRITERIA: { key: Criterion; label: string; hint: string }[] = [
  { key: 'golden', label: 'Golden hour', hint: 'Low warm sun around sunrise and sunset' },
  { key: 'blue', label: 'Blue hour', hint: 'Sun just below the horizon' },
  { key: 'sun', label: 'Sun on spot', hint: 'Not shaded by terrain or buildings' },
  { key: 'shade', label: 'Open shade', hint: 'Daylight with the spot in shade: soft, even light' },
  { key: 'align', label: 'Sun/moon alignment', hint: 'Sun or moon lines up with the spot’s facing' },
  { key: 'clear', label: 'Clear sky', hint: 'Little cloud' },
  { key: 'drama', label: 'Dramatic cloud', hint: 'Mid/high cloud 30–70%, low cloud light' },
  { key: 'fog', label: 'Fog / mist', hint: 'Fog likely or low visibility' },
  { key: 'dry', label: 'No rain', hint: 'Low chance of precipitation' },
  { key: 'calm', label: 'Low wind', hint: 'Gentle wind and gusts' },
  { key: 'train', label: 'Train passing', hint: 'Timetabled train passes near the spot' },
  { key: 'planes', label: 'Planes overhead', hint: 'Live traffic only: counts for right now' },
];
export const DEFAULT_CRITERIA: Criterion[] = ['golden', 'sun', 'dry'];

export interface WeatherHour {
  time: string; tempC: number; cloudPct: number; cloudLowPct: number; cloudMidPct: number; cloudHighPct: number;
  precipMm: number; precipProbPct: number; windKmh: number; gustKmh: number; visibilityM: number; weatherCode: number; fogLikely: boolean;
}
export interface WeatherResponse { lat: number; lng: number; fetchedAt: string; hourly: WeatherHour[] }

export interface Slot { t: Date; phase: Phase; light: Light }
export interface Pass { at: Date; label: string }
export interface Window { start: Date; end: Date; label: string }

type NumKey = Exclude<keyof WeatherHour, 'time' | 'fogLikely'>;
const NUM_KEYS: NumKey[] = ['tempC', 'cloudPct', 'cloudLowPct', 'cloudMidPct', 'cloudHighPct', 'precipMm', 'precipProbPct', 'windKmh', 'gustKmh', 'visibilityM', 'weatherCode'];

/** Weather at `t`, linearly interpolated between the surrounding hours (nearest for code and fog). Null outside the forecast. */
export function weatherAt(hourly: WeatherHour[], t: Date): WeatherHour | null {
  const x = t.getTime();
  for (let i = 0; i < hourly.length; i++) {
    const a = Date.parse(hourly[i].time);
    if (x === a) return hourly[i];
    const b = hourly[i + 1] ? Date.parse(hourly[i + 1].time) : NaN;
    if (x > a && x < b) {
      const f = (x - a) / (b - a), h0 = hourly[i], h1 = hourly[i + 1];
      const out = { ...(f < 0.5 ? h0 : h1), time: new Date(x).toISOString() };
      for (const k of NUM_KEYS) if (k !== 'weatherCode') out[k] = h0[k] + (h1[k] - h0[k]) * f;
      return out;
    }
  }
  return null;
}

const GOLDEN: Phase[] = ['sunrise', 'golden_am', 'golden_pm', 'sunset'];
const DAYLIGHT: Phase[] = [...GOLDEN, 'day'];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const r = (n: number) => Math.round(n);

export interface SlotScore { t: Date; score: number; reasons: string[]; misses: string[] }
export interface ScoreInput {
  slots: Slot[]; criteria: Criterion[]; weather?: WeatherHour[] | null; passes?: Pass[]; alignments?: Window[];
  now?: Date; livePlanes?: number | null; trainWindowMin?: number; fmt?: (d: Date) => string;
}

/** Each selected criterion scores 0–1 for the slot; the slot's score is their mean. */
export function scoreSlots(input: ScoreInput): SlotScore[] {
  const { slots, criteria, weather, passes = [], alignments = [], now = new Date(), livePlanes = null, trainWindowMin = 10 } = input;
  const fmt = input.fmt ?? ((d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  const crit = criteria.length ? criteria : DEFAULT_CRITERIA;
  return slots.map((s) => {
    const w = weather ? weatherAt(weather, s.t) : null;
    const reasons: string[] = [], misses: string[] = [];
    let total = 0;
    const add = (v: number, reason: string | null, miss: string) => {
      total += clamp01(v);
      if (v >= 0.5 && reason) reasons.push(reason); else misses.push(miss);
    };
    for (const c of crit) {
      switch (c) {
        case 'golden': add(GOLDEN.includes(s.phase) ? 1 : 0, 'Golden hour', 'not golden hour'); break;
        case 'blue': add(s.phase === 'blue' ? 1 : 0, 'Blue hour', 'not blue hour'); break;
        case 'sun': add(s.light === 'sun' ? 1 : 0, 'sun on spot', s.light === 'night' ? 'sun down' : 'spot in shade'); break;
        case 'shade': add(s.light === 'shade' && DAYLIGHT.includes(s.phase) ? 1 : 0, 'open shade', 'no open shade'); break;
        case 'align': {
          const a = alignments.find((x) => s.t >= x.start && s.t < x.end);
          add(a ? 1 : 0, a ? a.label : null, 'no alignment'); break;
        }
        case 'clear': w ? add(1 - w.cloudPct / 60, `${r(w.cloudPct)}% cloud`, `${r(w.cloudPct)}% cloud`) : add(0, null, 'no forecast'); break;
        case 'drama': {
          if (!w) { add(0, null, 'no forecast'); break; }
          const mh = Math.max(w.cloudMidPct, w.cloudHighPct);
          const v = (mh >= 30 && mh <= 70 ? 1 : mh < 30 ? mh / 30 : (100 - mh) / 30) * (1 - clamp01((w.cloudLowPct - 40) / 40));
          add(v, `${r(mh)}% ${w.cloudHighPct >= w.cloudMidPct ? 'high' : 'mid'} cloud`, `${r(mh)}% mid/high cloud`); break;
        }
        case 'fog': w ? add(w.fogLikely ? 1 : clamp01((5000 - w.visibilityM) / 4000), 'fog/mist likely', 'no fog') : add(0, null, 'no forecast'); break;
        case 'dry': w ? add(w.precipMm > 0.3 ? 0 : 1 - w.precipProbPct / 100, `${r(w.precipProbPct)}% rain chance`, `${r(w.precipProbPct)}% rain chance`) : add(0.5, null, 'rain unknown'); break;
        case 'calm': w ? add(1 - clamp01((Math.max(w.windKmh, w.gustKmh * 0.7) - 10) / 25), `wind ${r(w.windKmh)} km/h`, `wind ${r(w.windKmh)} km/h, gusts ${r(w.gustKmh)}`) : add(0.5, null, 'wind unknown'); break;
        case 'train': {
          const p = passes.find((x) => Math.abs(x.at.getTime() - s.t.getTime()) <= trainWindowMin * 60_000);
          add(p ? 1 : 0, p ? `${p.label} passes ${fmt(p.at)}` : null, 'no train'); break;
        }
        case 'planes': {
          const live = Math.abs(s.t.getTime() - now.getTime()) <= 30 * 60_000 && (livePlanes ?? 0) > 0;
          // Future traffic isn't knowable: a bonus for "now" only, never a penalty elsewhere.
          if (live) { total += 1; reasons.push(`${livePlanes} plane${livePlanes === 1 ? '' : 's'} overhead now`); } else total += 0.5;
          break;
        }
      }
    }
    return { t: s.t, score: total / crit.length, reasons, misses };
  });
}

export interface Recommendation extends SlotScore { end: Date; confidence: 'high' | 'medium' | 'low'; confidenceNote: string }

/** How much to trust the weather part: forecasts degrade with days out. */
export function confidenceFor(t: Date, now: Date, hasWeather: boolean, usesWeather: boolean): { confidence: Recommendation['confidence']; note: string } {
  if (!usesWeather) return { confidence: 'high', note: 'Sun, shade and timetables are predictable' };
  if (!hasWeather) return { confidence: 'low', note: 'No forecast for this time' };
  const days = (t.getTime() - now.getTime()) / 86_400_000;
  if (days < 1.5) return { confidence: 'high', note: 'Forecast within ~36 h: fairly reliable' };
  if (days < 4) return { confidence: 'medium', note: `Forecast ${Math.round(days)} days out: check again closer to the day` };
  return { confidence: 'low', note: `Forecast ${Math.round(days)} days out: cloud and rain may change a lot` };
}

const WEATHER_CRITERIA: Criterion[] = ['clear', 'drama', 'fog', 'dry', 'calm'];

/**
 * The top `n` times: skip the past, keep only slots scoring at least `minScore`, group adjacent slots of the
 * same score into one window, and keep windows at least `gapMin` apart so the list isn't one sunset five times.
 */
export function recommend(input: ScoreInput & { n?: number; stepMin?: number; gapMin?: number; minScore?: number }): Recommendation[] {
  const { n = 5, stepMin = 10, gapMin = 90, minScore = 0.34, now = new Date() } = input;
  const scored = scoreSlots({ ...input, now }).filter((s) => s.t.getTime() + stepMin * 60_000 > now.getTime() && s.score >= minScore);
  const usesWeather = (input.criteria.length ? input.criteria : DEFAULT_CRITERIA).some((c) => WEATHER_CRITERIA.includes(c));
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.t.getTime() - b.t.getTime());
  const byTime = new Map(scored.map((s) => [s.t.getTime(), s]));
  const out: Recommendation[] = [];
  for (const s of ranked) {
    if (out.length >= n) break;
    if (out.some((o) => Math.abs(o.t.getTime() - s.t.getTime()) < gapMin * 60_000)) continue;
    // Grow the window over neighbours with the same score.
    let start = s.t.getTime(), end = start + stepMin * 60_000;
    while (byTime.get(start - stepMin * 60_000)?.score === s.score) start -= stepMin * 60_000;
    while (byTime.get(end)?.score === s.score) end += stepMin * 60_000;
    const c = confidenceFor(new Date(start), now, !!(input.weather && weatherAt(input.weather, new Date(start))), usesWeather);
    out.push({ ...(byTime.get(start) ?? s), end: new Date(end), confidence: c.confidence, confidenceNote: c.note });
  }
  return out;
}

/** Closest distance (km) from a point to any rail line vertex/segment in a GeoJSON collection. Infinity when none. */
export function railDistanceKm(fc: GeoJSON.FeatureCollection | null | undefined, lat: number, lng: number): number {
  let best = Infinity;
  const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57;
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    const lines = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const [x1, y1] = line[i];
        if (i === 0 || line.length === 1) { best = Math.min(best, haversineKm(lat, lng, y1, x1)); if (line.length === 1) continue; }
        if (i === 0) continue;
        const [x0, y0] = line[i - 1];
        // Local planar projection: good to metres at these distances.
        const ax = (x0 - lng) * kx, ay = (y0 - lat) * ky, bx = (x1 - lng) * kx, by = (y1 - lat) * ky;
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        const u = len ? clamp01(-(ax * dx + ay * dy) / len) : 0;
        best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
      }
    }
  }
  return best;
}

/** Criteria list <-> compact URL/localStorage string ("golden,sun,dry"); unknown keys dropped. */
export function parseCriteria(s: string | null | undefined): Criterion[] | null {
  if (s == null) return null;
  const keys = new Set(CRITERIA.map((c) => c.key));
  return s.split(',').filter((k): k is Criterion => keys.has(k as Criterion));
}

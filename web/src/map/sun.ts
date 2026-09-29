/**
 * Sun and moon maths for the map, the spot panel and the Plan shoot page.
 * Pure (suncalc only): no MapLibre, no DOM, so node:test can run it.
 *
 * Light phases, by the sun's true (geometric) altitude h, and whether it is
 * rising (morning) or setting (evening):
 *
 *   h >= 6                  day
 *   2 <= h < 6              golden_am / golden_pm
 *   -0.833 <= h < 2         sunrise / sunset   (-0.833 is the published sunrise/sunset)
 *   -4 <= h < -0.833        golden_am / golden_pm
 *   -6 <= h < -4            blue
 *   -18 <= h < -6           night              (nautical + astronomical twilight)
 *   h < -18                 astro              (fully dark sky, Milky Way)
 *
 * Matching a spot's chosen phases, a phase also counts as its parent:
 * sunrise is part of golden_am, sunset of golden_pm, astro of night.
 */
import { getMoonIllumination, getMoonPosition, getPosition, getTimes } from 'suncalc';
import { angleDiff } from './geo.js';

export type Phase = 'night' | 'astro' | 'blue' | 'golden_am' | 'sunrise' | 'day' | 'golden_pm' | 'sunset';

export interface SpotLike {
  id: string;
  lat: number;
  lng: number;
  facingDeg: number | null;
  goodTimes: { phases: string[]; months: number[]; days: 'any' | 'weekday' | 'weekend' };
}

export const PHASE_LABEL: Record<Phase, string> = {
  sunrise: 'Sunrise', golden_am: 'Golden AM', day: 'Day', golden_pm: 'Golden PM',
  sunset: 'Sunset', blue: 'Blue hour', night: 'Night', astro: 'Astro',
};
/** Order for the editor's chips. */
export const PHASES: Phase[] = ['sunrise', 'golden_am', 'day', 'golden_pm', 'sunset', 'blue', 'night', 'astro'];

export const PHASE_COLOR: Record<Phase, string> = {
  astro: '#05070f', night: '#101830', blue: '#2f58c8', golden_am: '#f0a040',
  sunrise: '#ff7a3d', day: '#8fc4e8', golden_pm: '#f0a040', sunset: '#ff6a3d',
};

const PARENT: Partial<Record<Phase, Phase>> = { sunrise: 'golden_am', sunset: 'golden_pm', astro: 'night' };

const HORIZON_REFRACTION = 0.4843; // suncalc's refraction below the horizon, degrees

/** suncalc 2 returns apparent altitude; undo refraction (Bennett) to get the true altitude. */
export function trueAltitude(apparent: number): number {
  if (apparent <= HORIZON_REFRACTION) return apparent - HORIZON_REFRACTION;
  return apparent - 1 / 60 / Math.tan(((apparent + 7.31 / (apparent + 4.4)) * Math.PI) / 180);
}

export function sunPos(date: Date, lat: number, lng: number): { azimuth: number; altitude: number } {
  const p = getPosition(date, lat, lng);
  return { azimuth: p.azimuth, altitude: trueAltitude(p.altitude) };
}

export function moonPos(date: Date, lat: number, lng: number): { azimuth: number; altitude: number } {
  const p = getMoonPosition(date, lat, lng);
  return { azimuth: p.azimuth, altitude: p.altitude };
}

const MOON_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
export function moonPhase(date: Date): { fraction: number; phase: number; name: string } {
  const m = getMoonIllumination(date);
  return { fraction: m.fraction, phase: m.phase, name: MOON_NAMES[Math.round(m.phase * 8) % 8] };
}

export function phaseFor(alt: number, rising: boolean): Phase {
  if (alt >= 6) return 'day';
  if (alt >= -0.833 && alt < 2) return rising ? 'sunrise' : 'sunset';
  if (alt >= -4) return rising ? 'golden_am' : 'golden_pm';
  if (alt >= -6) return 'blue';
  if (alt >= -18) return 'night';
  return 'astro';
}

export function phaseAt(date: Date, lat: number, lng: number): Phase {
  const alt = sunPos(date, lat, lng).altitude;
  const next = sunPos(new Date(date.getTime() + 60_000), lat, lng).altitude;
  return phaseFor(alt, next > alt);
}

export interface Band<T = Phase> { phase: T; start: Date; end: Date }

function localDay(date: Date): [Date, Date] {
  return [new Date(date.getFullYear(), date.getMonth(), date.getDate()), new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)];
}

/** The phases across `date`'s local day, 1-minute resolution. */
export function dayPhases(date: Date, lat: number, lng: number): Band[] {
  const [start, end] = localDay(date);
  const n = Math.round((end.getTime() - start.getTime()) / 60_000);
  const alts: number[] = [];
  for (let i = 0; i <= n; i++) alts.push(sunPos(new Date(start.getTime() + i * 60_000), lat, lng).altitude);
  const bands: Band[] = [];
  for (let i = 0; i < n; i++) {
    const phase = phaseFor(alts[i], alts[i + 1] > alts[i]);
    const t = new Date(start.getTime() + i * 60_000);
    const last = bands.at(-1);
    if (last && last.phase === phase) last.end = new Date(t.getTime() + 60_000);
    else bands.push({ phase, start: t, end: new Date(t.getTime() + 60_000) });
  }
  return bands;
}

/** When the moon is above the horizon on `date`'s local day, 5-minute resolution. */
export function moonUpBands(date: Date, lat: number, lng: number): Band<'up'>[] {
  const [start, end] = localDay(date);
  const out: Band<'up'>[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += 5 * 60_000) {
    if (moonPos(new Date(t), lat, lng).altitude <= 0) continue;
    const last = out.at(-1);
    if (last && last.end.getTime() === t) last.end = new Date(t + 5 * 60_000);
    else out.push({ phase: 'up', start: new Date(t), end: new Date(t + 5 * 60_000) });
  }
  return out;
}

/** Sunrise and sunset time and azimuth for `date`'s local day. */
export function sunriseSunset(date: Date, lat: number, lng: number) {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const t = getTimes(noon, lat, lng);
  const at = (d: Date | null) => (d ? { time: d, azimuth: getPosition(d, lat, lng).azimuth } : null);
  return { sunrise: at(t.sunrise), sunset: at(t.sunset) };
}

// --- exact bearing golden-hour planning ---------------------------------------------

export type SunBearingPhase = 'sunrise' | 'sunset' | 'both';

export const SUN_BEARING_SEARCH_DAYS = 365;
export const SUN_BEARING_RESULT_PREVIEW_COUNT = 2;
export const SUN_BEARING_RESULT_LIMIT = 8;
export const SUN_BEARING_DEFAULT_WINDOWS = {
  sunriseOffsetStartMin: -30,
  sunriseOffsetEndMin: 60,
  sunsetOffsetStartMin: -60,
  sunsetOffsetEndMin: 30,
} as const;

export interface SunBearingPlanOptions {
  lat: number;
  lng: number;
  bearingDeg: number;
  phase: SunBearingPhase;
  startDate: Date;
  days: number;
  sunriseOffsetStartMin?: number;
  sunriseOffsetEndMin?: number;
  sunsetOffsetStartMin?: number;
  sunsetOffsetEndMin?: number;
}

export interface SunBearingPlanHit {
  date: Date;
  time: Date;
  azimuthDeg: number;
  altitudeDeg: number;
  signedErrorDeg: number;
  absoluteErrorDeg: number;
  phase: 'sunrise' | 'sunset';
}

export function sunBearingSearchStart(today: Date): Date {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

export function displayedSunBearingHits<T>(hits: T[], expanded: boolean, previewCount = SUN_BEARING_RESULT_PREVIEW_COUNT): T[] {
  return expanded ? hits : hits.slice(0, previewCount);
}

const MINUTE = 60_000;
const SECOND = 1000;

function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

function sunPosDeg(date: Date, lat: number, lng: number): { azimuthDeg: number; altitudeDeg: number } {
  const p = getPosition(date, lat, lng);
  return {
    azimuthDeg: normDeg(p.azimuth),
    altitudeDeg: trueAltitude(p.altitude),
  };
}

function planCandidate(time: Date, lat: number, lng: number, bearingDeg: number, phase: 'sunrise' | 'sunset'): SunBearingPlanHit {
  const pos = sunPosDeg(time, lat, lng);
  const signedErrorDeg = angleDiff(pos.azimuthDeg, bearingDeg);
  return {
    date: new Date(time.getFullYear(), time.getMonth(), time.getDate()),
    time,
    azimuthDeg: pos.azimuthDeg,
    altitudeDeg: pos.altitudeDeg,
    signedErrorDeg,
    absoluteErrorDeg: Math.abs(signedErrorDeg),
    phase,
  };
}

function closestInWindow(lat: number, lng: number, bearingDeg: number, phase: 'sunrise' | 'sunset', start: number, end: number): SunBearingPlanHit | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  if (hi < lo) return null;

  let best: SunBearingPlanHit | null = null;
  for (let t = lo; t <= hi; t += MINUTE) {
    const hit = planCandidate(new Date(t), lat, lng, bearingDeg, phase);
    if (!best || hit.absoluteErrorDeg < best.absoluteErrorDeg) best = hit;
  }
  if (!best) return null;

  const refineStart = Math.ceil(Math.max(lo, best.time.getTime() - MINUTE) / SECOND) * SECOND;
  const refineEnd = Math.floor(Math.min(hi, best.time.getTime() + MINUTE) / SECOND) * SECOND;
  for (let t = refineStart; t <= refineEnd; t += SECOND) {
    const hit = planCandidate(new Date(t), lat, lng, bearingDeg, phase);
    if (hit.absoluteErrorDeg < best.absoluteErrorDeg) best = hit;
  }
  return best;
}

/**
 * Closest sunrise/sunset golden-hour moments to an exact compass bearing.
 * Scans each manual window at 1-minute resolution, then refines the winning
 * minute to seconds.
 */
export function planSunBearing(options: SunBearingPlanOptions): SunBearingPlanHit[] {
  const days = Math.max(0, Math.floor(options.days));
  const bearingDeg = normDeg(options.bearingDeg);
  const phases: ('sunrise' | 'sunset')[] = options.phase === 'both' ? ['sunrise', 'sunset'] : [options.phase];
  const hits: SunBearingPlanHit[] = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(options.startDate.getFullYear(), options.startDate.getMonth(), options.startDate.getDate() + i, 12);
    const times = getTimes(day, options.lat, options.lng);
    for (const phase of phases) {
      const eventTime = times[phase];
      if (!(eventTime instanceof Date) || Number.isNaN(eventTime.getTime())) continue;
      const startOffset = phase === 'sunrise' ? options.sunriseOffsetStartMin ?? -30 : options.sunsetOffsetStartMin ?? -30;
      const endOffset = phase === 'sunrise' ? options.sunriseOffsetEndMin ?? 60 : options.sunsetOffsetEndMin ?? 30;
      const hit = closestInWindow(
        options.lat,
        options.lng,
        bearingDeg,
        phase,
        eventTime.getTime() + startOffset * MINUTE,
        eventTime.getTime() + endOffset * MINUTE,
      );
      if (hit) hits.push(hit);
    }
  }

  return hits.sort((a, b) => a.time.getTime() - b.time.getTime());
}

/** The closest exact-bearing golden-hour alignment in the requested date range. */
export function closestSunBearing(options: SunBearingPlanOptions): SunBearingPlanHit | null {
  const hits = planSunBearing(options);
  return hits.reduce<SunBearingPlanHit | null>((best, hit) =>
    !best || hit.absoluteErrorDeg < best.absoluteErrorDeg ? hit : best,
  null);
}

// --- good times -------------------------------------------------------------------

/**
 * Whether the spot's good times match `date`: its phases (required: a spot
 * that names none never counts as "good now"), its months (none = any) and
 * its day type, all in local time.
 */
export function goodNow(spot: SpotLike, date: Date): boolean {
  const gt = spot.goodTimes;
  if (!gt.phases.length) return false;
  if (gt.months.length && !gt.months.includes(date.getMonth() + 1)) return false;
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (gt.days === 'weekday' && weekend) return false;
  if (gt.days === 'weekend' && !weekend) return false;
  const p = phaseAt(date, spot.lat, spot.lng);
  const parent = PARENT[p];
  return gt.phases.includes(p) || (parent !== undefined && gt.phases.includes(parent));
}

/** The first window from `from` (within `days`) where goodNow holds, at `stepMin` resolution. */
export function nextGoodWindow(spot: SpotLike, from: Date, days = 7, stepMin = 10): { start: Date; end: Date; phase: Phase } | null {
  if (!spot.goodTimes.phases.length) return null;
  const step = stepMin * 60_000;
  const stop = from.getTime() + days * 86_400_000;
  let start: number | null = null;
  for (let t = from.getTime(); t < stop; t += step) {
    const ok = goodNow(spot, new Date(t));
    if (ok && start === null) start = t;
    if (!ok && start !== null) return { start: new Date(start), end: new Date(t), phase: phaseAt(new Date(start), spot.lat, spot.lng) };
  }
  return start === null ? null : { start: new Date(start), end: new Date(stop), phase: phaseAt(new Date(start), spot.lat, spot.lng) };
}

// --- alignments ---------------------------------------------------------------------

export interface Alignment { body: 'sun' | 'moon'; start: Date; end: Date; azimuth: number; altitude: number }

const STEP = 5 * 60_000;
const MAX_ALT_RATE = 0.25; // degrees per minute: the sun's fastest, at the equator; the moon is slower
const cache = new Map<string, Alignment[]>();

function scanBody(body: 'sun' | 'moon', lat: number, lng: number, facing: number, start: number, end: number): Alignment[] {
  const pos = body === 'sun' ? sunPos : moonPos;
  const out: Alignment[] = [];
  let cur: Alignment | null = null;
  for (let t = start; t < end;) {
    const p = pos(new Date(t), lat, lng);
    const ok = p.altitude >= -1 && p.altitude <= 10 && Math.abs(angleDiff(p.azimuth, facing)) <= 10;
    if (ok && cur) cur.end = new Date(t + STEP);
    else if (ok) cur = { body, start: new Date(t), end: new Date(t + STEP), azimuth: p.azimuth, altitude: p.altitude };
    else if (cur) { out.push(cur); cur = null; }
    // Far above or below the band, jump ahead as far as the body can't possibly reach it.
    const off = p.altitude > 10 ? p.altitude - 10 : p.altitude < -1 ? -1 - p.altitude : 0;
    t += Math.max(STEP, Math.floor(off / MAX_ALT_RATE / 5) * STEP);
  }
  if (cur) out.push(cur);
  return out;
}

function alignmentsForDay(spot: SpotLike, day: Date): Alignment[] {
  const [start, end] = localDay(day);
  const key = `${spot.id}:${spot.lat}:${spot.lng}:${spot.facingDeg}:${start.getTime()}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = [
      ...scanBody('sun', spot.lat, spot.lng, spot.facingDeg!, start.getTime(), end.getTime()),
      ...scanBody('moon', spot.lat, spot.lng, spot.facingDeg!, start.getTime(), end.getTime()),
    ].sort((a, b) => a.start.getTime() - b.start.getTime());
    cache.set(key, hit);
  }
  return hit;
}

/**
 * The next `n` windows (from `from`, over `days` days) where the sun or moon
 * sits within ±10° of the spot's facing, between -1° and 10° altitude.
 * Cached per spot per local day.
 */
export function alignments(spot: SpotLike, from: Date, days = 365, n = 3): Alignment[] {
  if (spot.facingDeg == null) return [];
  const out: Alignment[] = [];
  for (let d = 0; d < days && out.length < n; d++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, 12);
    for (const w of alignmentsForDay(spot, day)) {
      if (w.end <= from) continue;
      const last = out.at(-1);
      // A window running over midnight comes back as two; join them.
      if (last && last.body === w.body && last.end.getTime() === w.start.getTime()) last.end = w.end;
      else if (out.length < n) out.push({ ...w });
    }
  }
  return out;
}

// --- map mood ---------------------------------------------------------------------

// [true altitude, r, g, b, alpha] keyframes for the tint laid over the base map.
const MOOD: [number, number, number, number, number][] = [
  [-18, 4, 6, 20, 0.74], [-10, 10, 18, 55, 0.64], [-6, 28, 55, 150, 0.46], [-4, 50, 80, 180, 0.34],
  [-2, 220, 115, 60, 0.24], [2, 255, 135, 45, 0.22], [6, 255, 170, 80, 0.1], [12, 255, 220, 160, 0],
];

/** The tint colour and opacity for a sun altitude: warm at golden hour, blue at blue hour, dark at night. */
export function moodAt(alt: number): { color: string; opacity: number } {
  const k = MOOD;
  if (alt <= k[0][0]) return { color: `rgb(${k[0][1]},${k[0][2]},${k[0][3]})`, opacity: k[0][4] };
  if (alt >= k.at(-1)![0]) return { color: 'rgb(255,220,160)', opacity: 0 };
  const i = k.findIndex((row) => row[0] > alt);
  const [a0, ...c0] = k[i - 1];
  const [a1, ...c1] = k[i];
  const f = (alt - a0) / (a1 - a0);
  const mix = c0.map((v, j) => v + (c1[j] - v) * f);
  return { color: `rgb(${Math.round(mix[0])},${Math.round(mix[1])},${Math.round(mix[2])})`, opacity: mix[3] };
}

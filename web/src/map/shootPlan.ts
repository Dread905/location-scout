/** Plan shoot: sun/shade across a day at one spot, and the best windows. Pure (the page supplies the shade tests). */
import { phaseFor, sunPos, type Phase } from './sun.js';
import { shadowMask, type Grid } from './terrainShadow.js';
import { DEFAULT_HEIGHT, shadowPolygon, type Footprint } from './shadows.js';

export type Light = 'sun' | 'shade' | 'night';
export type ShadeTest = (azimuth: number, altitude: number) => boolean;
export interface Step { t: Date; phase: Phase; azimuth: number; altitude: number; light: Light; terrain: boolean; buildings: boolean }

/** Every `stepMin` minutes across `day`'s local day: phase, sun, and whether terrain or buildings shade the spot. */
export function lightTimeline(day: Date, lat: number, lng: number, shade: { terrain?: ShadeTest | null; buildings?: ShadeTest | null }, stepMin = 10): Step[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const out: Step[] = [];
  for (let t = start; t < end; t += stepMin * 60_000) {
    const { azimuth, altitude } = sunPos(new Date(t), lat, lng);
    const next = sunPos(new Date(t + 60_000), lat, lng).altitude;
    const up = altitude > 0;
    const terrain = up && !!shade.terrain?.(azimuth, altitude);
    const buildings = up && !terrain && !!shade.buildings?.(azimuth, altitude);
    out.push({ t: new Date(t), phase: phaseFor(altitude, next > altitude), azimuth, altitude, light: !up ? 'night' : terrain || buildings ? 'shade' : 'sun', terrain, buildings });
  }
  return out;
}

export type WindowKind = 'golden-sun' | 'even-shade';
export const WINDOW_LABEL: Record<WindowKind, string> = {
  'golden-sun': 'Golden light on the spot',
  'even-shade': 'Open shade: even light',
};
const GOLDEN: Phase[] = ['sunrise', 'golden_am', 'golden_pm', 'sunset'];

/** Contiguous runs where the spot is sunlit in golden hour, or shaded in full daylight (soft, even light). */
export function bestWindows(steps: Step[], stepMin = 10): { kind: WindowKind; start: Date; end: Date }[] {
  const kindOf = (s: Step): WindowKind | null =>
    s.light === 'sun' && GOLDEN.includes(s.phase) ? 'golden-sun' : s.light === 'shade' && s.phase === 'day' ? 'even-shade' : null;
  const out: { kind: WindowKind; start: Date; end: Date }[] = [];
  for (const s of steps) {
    const k = kindOf(s), end = new Date(s.t.getTime() + stepMin * 60_000), last = out.at(-1);
    if (!k) continue;
    if (last && last.kind === k && last.end.getTime() === s.t.getTime()) last.end = end;
    else out.push({ kind: k, start: s.t, end });
  }
  return out;
}

/** Terrain shade at grid pixel (x, y): shadowMask on a 1×1 window. */
export function terrainShadeAt(grid: Grid, mPerPx: number, x: number, y: number): ShadeTest {
  const win = { x0: Math.round(x), y0: Math.round(y), w: 1, h: 1 };
  return (az, alt) => shadowMask(grid, mPerPx, az, alt, win)[0] === 1;
}

type Pt = [number, number];
function inRing(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Building shade at a point: inside any building's shadow hull (shadows.ts). A building the point stands in
 * (a rooftop spot) doesn't shade it. Hull tests instead of the unioned polygons: same answer for one point, no polyclip.
 */
export function buildingShadeAt(features: Footprint[], lng: number, lat: number): ShadeTest {
  const blds: { ring: Pt[]; h: number }[] = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as Pt[][][];
    const h = Number(f.properties?.render_height ?? f.properties?.height ?? DEFAULT_HEIGHT) || DEFAULT_HEIGHT;
    for (const p of polys) if (p[0]?.length >= 4 && !inRing(p[0], lng, lat)) blds.push({ ring: p[0], h });
  }
  return (az, alt) => blds.some((b) => inRing(shadowPolygon(b.ring, b.h, az, alt), lng, lat));
}

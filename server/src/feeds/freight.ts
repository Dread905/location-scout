/**
 * Freight/coal train sightings: snapping to the rail network, projecting a
 * sighting forward along the line, and the "usually passes here" histogram.
 * All pure and planar (small-scale, local equirectangular projection) —
 * fine at rail-corridor distances, not for e.g. a line spanning degrees of latitude.
 */
import { haversine } from '../geo.js';

export interface LatLng { lat: number; lng: number }
export interface RailLine { ref: string; coords: [number, number][] } // [lng, lat], as GeoJSON stores it

const DEG_KM = 111.32;
function toXY(lat: number, lng: number, refLat: number): [number, number] {
  return [lng * DEG_KM * Math.cos((refLat * Math.PI) / 180), lat * DEG_KM];
}
function fromXY(x: number, y: number, refLat: number): LatLng {
  return { lat: y / DEG_KM, lng: x / (DEG_KM * Math.cos((refLat * Math.PI) / 180)) };
}

interface LineGeom { refLat: number; xy: [number, number][]; cum: number[]; total: number }
function buildLineGeom(coords: [number, number][]): LineGeom {
  const refLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const xy = coords.map(([lng, lat]) => toXY(lat, lng, refLat));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    cum.push(cum[i - 1] + Math.hypot(x1 - x0, y1 - y0));
  }
  return { refLat, xy, cum, total: cum.at(-1) ?? 0 };
}

export interface LineProjection { atKm: number; offKm: number; lat: number; lng: number }

/** Nearest point on a line to `point`: distance travelled along the line, and the perpendicular offset. */
export function projectOntoLine(coords: [number, number][], point: LatLng): LineProjection | null {
  if (coords.length < 2) return null;
  const g = buildLineGeom(coords);
  const [px, py] = toXY(point.lat, point.lng, g.refLat);
  let best: LineProjection | null = null;
  for (let i = 1; i < g.xy.length; i++) {
    const [ax, ay] = g.xy[i - 1];
    const [bx, by] = g.xy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const off = Math.hypot(px - cx, py - cy);
    if (!best || off < best.offKm) {
      const atKm = g.cum[i - 1] + t * Math.hypot(dx, dy);
      const { lat, lng } = fromXY(cx, cy, g.refLat);
      best = { atKm, offKm: off, lat, lng };
    }
  }
  return best;
}

/** The nearest rail line to a point, snapped, or null if nothing is within `maxOffKm`. */
export function snapToNearestLine(lines: RailLine[], point: LatLng, maxOffKm = 0.3): { lineRef: string; lat: number; lng: number } | null {
  let best: { lineRef: string; lat: number; lng: number; offKm: number } | null = null;
  for (const line of lines) {
    const p = projectOntoLine(line.coords, point);
    if (p && (!best || p.offKm < best.offKm)) best = { lineRef: line.ref, lat: p.lat, lng: p.lng, offKm: p.offKm };
  }
  return best && best.offKm <= maxOffKm ? best : null;
}

/** The point reached after travelling `atKm` along a line (clamped to its length). Shared with feeds/trains.ts. */
export function pointAtDistanceOnLine(coords: [number, number][], atKm: number): LatLng {
  const g = buildLineGeom(coords);
  const targetKm = Math.max(0, Math.min(g.total, atKm));
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < targetKm) i++;
  const segStart = g.cum[i - 1];
  const segEnd = g.cum[i];
  const t = segEnd === segStart ? 0 : (targetKm - segStart) / (segEnd - segStart);
  const [ax, ay] = g.xy[i - 1];
  const [bx, by] = g.xy[i];
  return fromXY(ax + t * (bx - ax), ay + t * (by - ay), g.refLat);
}

/**
 * Project a sighting forward along its line at a constant speed. `direction`
 * is which way it was heading along the line's own point order: 'up' toward
 * the line's end, 'down' toward its start.
 * ponytail: constant speed, no junctions or reversals; good enough for a
 * ~60-90 min ghost marker, add junction-aware routing if that stops holding.
 */
export function projectAlongLine(coords: [number, number][], startPoint: LatLng, direction: 'up' | 'down', speedKmh: number, minutes: number): LatLng | null {
  const start = projectOntoLine(coords, startPoint);
  if (!start) return null;
  const deltaKm = (speedKmh * minutes) / 60;
  return pointAtDistanceOnLine(coords, start.atKm + (direction === 'up' ? deltaKm : -deltaKm));
}

export interface HistogramEntry { weekday: number; hour: number; count: number } // weekday: 0=Sunday..6=Saturday, as Date#getDay()

/** Weekday x hour counts for sightings within 2km of `spot`. */
export function passHistogram(sightings: { lat: number; lng: number; seenAt: string }[], spot: LatLng, radiusKm = 2): HistogramEntry[] {
  const grid = new Map<string, number>();
  for (const s of sightings) {
    if (haversine(spot.lat, spot.lng, s.lat, s.lng) > radiusKm * 1000) continue;
    const d = new Date(s.seenAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getDay()}:${d.getHours()}`;
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }
  return [...grid.entries()].map(([key, count]) => {
    const [weekday, hour] = key.split(':').map(Number);
    return { weekday, hour, count };
  });
}

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue–Sat 09–11" style summary, or null when there isn't enough history yet. */
export function describePassPattern(histogram: HistogramEntry[], minCount = 3): string | null {
  const total = histogram.reduce((s, e) => s + e.count, 0);
  if (total < minCount) return null;
  const days = [...new Set(histogram.map((e) => e.weekday))].sort((a, b) => a - b);
  const hours = histogram.map((e) => e.hour);
  const dayLabel = days.length === 1 ? WEEKDAY_LABEL[days[0]] : `${WEEKDAY_LABEL[days[0]]}–${WEEKDAY_LABEL[days.at(-1)!]}`;
  return `${dayLabel} ${String(Math.min(...hours)).padStart(2, '0')}–${String(Math.max(...hours) + 1).padStart(2, '0')}`;
}

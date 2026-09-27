/** Pure geometry for 3D trains: carriage counts, carriages laid along the track, and box meshes. No MapLibre, no DOM. */
import { cumulative, offset, pointAlong } from './motion.js';

/** Real-world carriage size, metres (Sydney Trains Waratah cars are ~20 m x 3 m x 4.4 m). */
export const CAR_LEN_M = 20;
export const CAR_GAP_M = 1;
export const CAR_WIDTH_M = 3;
export const CAR_HEIGHT_M = 4.2;
export const MAX_CARRIAGES = 16;

/**
 * How many carriages to draw: the realtime consist when the feed gave one, else a default for the service.
 * Sydney Trains 8 (its few 4-car workings aren't told apart); NSW TrainLink: XPT 7, Xplorer 3, Hunter/Endeavour
 * railcars 2, anything else 4.
 */
export function carriageCount(t: { carriages?: number | null; network?: string | null; route?: string; routeId?: string }): number {
  if (typeof t.carriages === 'number' && Number.isFinite(t.carriages) && t.carriages >= 1) return Math.min(MAX_CARRIAGES, Math.round(t.carriages));
  const name = `${t.route ?? ''} ${t.routeId ?? ''}`;
  if (t.network === 'sydneytrains') return 8;
  if (/\bXPT\b/i.test(name)) return 7;
  if (/xplorer/i.test(name)) return 3;
  if (/hunter|endeavour/i.test(name)) return 2;
  if (t.network === 'nswtrains') return 4;
  return /^T\d/i.test(name.trim()) ? 8 : 4;
}

export interface Carriage { front: [number, number]; rear: [number, number]; bearing: number }

/**
 * `n` carriages behind a lead point, each a chord between two points on the track so they bend round curves.
 * `path` is [lng, lat] in the direction of travel with the lead at `headKm`; without a path they trail straight
 * back from `head` along `bearing`. `scale` stretches lengths (used to keep them visible when zoomed out).
 */
export function placeCarriages(
  opts: { path?: [number, number][] | null; headKm?: number; head: [number, number]; bearing: number | null },
  n: number, scale = 1,
): Carriage[] {
  const len = (CAR_LEN_M * scale) / 1000;
  const gap = (CAR_GAP_M * scale) / 1000;
  const path = opts.path && opts.path.length >= 2 && opts.headKm != null ? opts.path : null;
  const cum = path ? cumulative(path) : null;
  // Offset the whole chain so its nose is exactly at the drawn head (the drawn head may be slightly off the shape).
  const at = (km: number): [number, number] => {
    if (path) {
      const p = pointAlong(path, km, cum!);
      const h = pointAlong(path, opts.headKm!, cum!);
      return [p.lng + opts.head[0] - h.lng, p.lat + opts.head[1] - h.lat];
    }
    return offset(opts.head, ((opts.bearing ?? 0) + 180) % 360, -km);
  };
  const out: Carriage[] = [];
  let km = path ? opts.headKm! : 0;
  for (let i = 0; i < n; i++) {
    const front = at(km);
    const rear = at(km - len);
    const bearing = front[0] === rear[0] && front[1] === rear[1] ? (opts.bearing ?? 0) : bearingDeg(rear, front);
    out.push({ front, rear, bearing });
    km -= len + gap;
  }
  return out;
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/**
 * Triangles for a box from `rear` to `front` (local metres: x east, y north, z up), `w` wide and `h` tall, sitting
 * on z = `z0`/`z1` at each end. Faces carry a shade (1 top, 0.8 sides, 0.65 ends) for simple lighting.
 */
export function boxTriangles(rear: [number, number], front: [number, number], w: number, h: number, z0: number, z1: number): { p: [number, number, number]; shade: number }[] {
  const dx = front[0] - rear[0];
  const dy = front[1] - rear[1];
  const L = Math.hypot(dx, dy) || 1;
  const [px, py] = [(-dy / L) * (w / 2), (dx / L) * (w / 2)]; // left-hand perpendicular
  const c = (end: 0 | 1, side: 1 | -1, top: 0 | 1): [number, number, number] => {
    const [bx, by] = end ? front : rear;
    return [bx + side * px, by + side * py, (end ? z1 : z0) + top * h];
  };
  const quad = (a: [number, number, number], b: [number, number, number], cc: [number, number, number], d: [number, number, number], shade: number) =>
    [a, b, cc, a, cc, d].map((p) => ({ p, shade }));
  return [
    ...quad(c(0, 1, 1), c(1, 1, 1), c(1, -1, 1), c(0, -1, 1), 1), // roof
    ...quad(c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1), 0.8), // left side
    ...quad(c(0, -1, 0), c(1, -1, 0), c(1, -1, 1), c(0, -1, 1), 0.72), // right side
    ...quad(c(1, 1, 0), c(1, -1, 0), c(1, -1, 1), c(1, 1, 1), 0.65), // front
    ...quad(c(0, 1, 0), c(0, -1, 0), c(0, -1, 1), c(0, 1, 1), 0.65), // rear
  ];
}

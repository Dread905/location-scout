/**
 * Smooth vehicle movement between feed polls: planes dead-reckon from ground speed and track, trains run along a
 * slice of their trip's shape at their speed. A new poll blends from where the vehicle is drawn to its new
 * prediction rather than jumping. Pure (time is passed in), no MapLibre, no DOM.
 */
import { deadReckon } from './planes.js';

export interface Pose {
  lng: number; lat: number; bearing: number | null;
  /** km along the train's path, when it has one */ pathKm?: number;
  /** The path `pathKm` is measured along. */ path?: [number, number][];
}
export type Predict = ((elapsedMs: number) => Pose) & {
  /** For a vehicle on a path: where a pose lies along it (km), or null when it's not on it; and the pose at a km. */
  onPath?: { project: (p: Pose) => number | null; at: (km: number) => Pose };
};

/** How long a new poll takes to blend in from the drawn position. */
export const BLEND_MS = 1500;
/** Past this jump (km) a new poll snaps instead of gliding across the map. */
export const MAX_BLEND_KM = 5;
/** Don't extrapolate further than this past a poll (the next poll is due well before). */
export const MAX_PLANE_EXTRAP_MS = 60_000;
export const MAX_TRAIN_EXTRAP_MS = 45_000;

const DEG_KM = 111.32;
const cosLat = (lat: number) => Math.cos((lat * Math.PI) / 180);

/** Approximate km between two [lng, lat] points (local equirectangular). */
export function distKm(a: [number, number], b: [number, number]): number {
  const k = cosLat((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * DEG_KM * k, (b[1] - a[1]) * DEG_KM);
}

export function bearingOf(a: [number, number], b: [number, number]): number {
  const k = cosLat((a[1] + b[1]) / 2);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/** The point `km` from [lng, lat] along a compass bearing (flat, small distances). */
export function offset(p: [number, number], bearingDeg: number, km: number): [number, number] {
  const t = (bearingDeg * Math.PI) / 180;
  return [p[0] + (Math.sin(t) * km) / (DEG_KM * cosLat(p[1])), p[1] + (Math.cos(t) * km) / DEG_KM];
}

export function cumulative(path: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + distKm(path[i - 1], path[i]));
  return out;
}

/**
 * The point `km` along a polyline, and the line's bearing there. Beyond either end it carries on straight along the
 * end segment, so carriages behind a short path (or a train run past its slice) still line up.
 */
export function pointAlong(path: [number, number][], km: number, cum = cumulative(path)): { lng: number; lat: number; bearing: number } {
  if (path.length === 1) return { lng: path[0][0], lat: path[0][1], bearing: 0 };
  let i = 1;
  while (i < cum.length - 1 && cum[i] < km) i++;
  // Skip zero-length segments for the bearing.
  let a = i - 1; let b = i;
  while (cum[b] === cum[a] && b < cum.length - 1) b++;
  while (cum[b] === cum[a] && a > 0) a--;
  const brg = bearingOf(path[a], path[b]);
  const seg = cum[b] - cum[a];
  const t = seg === 0 ? 0 : (km - cum[a]) / seg; // <0 or >1 past the ends: extrapolate
  const [x, y] = [path[a][0] + t * (path[b][0] - path[a][0]), path[a][1] + t * (path[b][1] - path[a][1])];
  return { lng: x, lat: y, bearing: brg };
}

const smooth = (t: number) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** Pose after `elapsedMs` for a plane: dead-reckoned from its report (`seenSec` old when fetched); still if no track/speed. */
export function planePredict(p: { lat: number; lon: number; track: number | null; gs: number | null; seen?: number }): Predict {
  const seen = Math.min(30, Math.max(0, p.seen ?? 0)) * 1000;
  return (elapsedMs) => {
    const ms = Math.min(MAX_PLANE_EXTRAP_MS, Math.max(0, elapsedMs) + seen);
    const d = deadReckon(p, ms / 60_000);
    return d ? { lng: d.lon, lat: d.lat, bearing: p.track } : { lng: p.lon, lat: p.lat, bearing: p.track };
  };
}

export interface TrainLike { lat: number; lng: number; bearing?: number | null; speedMps?: number | null; path?: [number, number][]; pathAtKm?: number }

/** Pose after `elapsedMs` for a train: along its path at its speed when it has both, else where it was reported. */
export function trainPredict(t: TrainLike): Predict {
  const path = t.path && t.path.length >= 2 ? t.path : null;
  if (!path || t.pathAtKm == null) return () => ({ lng: t.lng, lat: t.lat, bearing: t.bearing ?? null });
  const cum = cumulative(path);
  const end = cum.at(-1)!;
  const at0 = t.pathAtKm;
  const mps = t.speedMps ?? 0;
  // The path is the track (snapped server-side): the train is always drawn on it, at its km, never off to the side.
  const at = (km: number): Pose => {
    const p = pointAlong(path, km, cum);
    return { lng: p.lng, lat: p.lat, bearing: mps > 0 || t.bearing == null ? p.bearing : t.bearing, pathKm: km, path };
  };
  const f: Predict = (elapsedMs) => at(Math.min(end, at0 + (mps * Math.min(MAX_TRAIN_EXTRAP_MS, Math.max(0, elapsedMs))) / 1e6));
  f.onPath = {
    at,
    project: (p) => {
      // The old pose's own path position, if it lies on this path (within a few metres); else null.
      let best: { km: number; off: number } | null = null;
      for (let i = 1; i < path.length; i++) {
        const k = cosLat(path[i - 1][1]);
        const [bx, by] = [(path[i][0] - path[i - 1][0]) * DEG_KM * k, (path[i][1] - path[i - 1][1]) * DEG_KM];
        const [px, py] = [(p.lng - path[i - 1][0]) * DEG_KM * k, (p.lat - path[i - 1][1]) * DEG_KM];
        const L2 = bx * bx + by * by;
        const u = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
        const off = Math.hypot(px - u * bx, py - u * by);
        if (!best || off < best.off) best = { km: cum[i - 1] + u * (cum[i] - cum[i - 1]), off };
      }
      return best && best.off <= ON_PATH_KM ? best.km : null;
    },
  };
  return f;
}

/** A drawn pose within this of a train's new path counts as on it, and blends along the track. */
export const ON_PATH_KM = 0.008;

interface Track { from: Pose | null; start: number; predict: Predict; key?: string; /** blend start as km along the new path */ fromKm?: number | null }

/** Animated poses for a set of vehicles, keyed by id. `update` on each poll, `pose` every frame. */
export class MotionTracker {
  private tracks = new Map<string, Track>();

  /** `key` identifies the report: an item whose key is unchanged (a cached poll served again) keeps running as it was. */
  update(items: { id: string; predict: Predict; key?: string }[], now: number) {
    const next = new Map<string, Track>();
    for (const it of items) {
      const old = this.tracks.get(it.id);
      if (old && it.key != null && old.key === it.key) { next.set(it.id, old); continue; }
      const cur = this.pose(it.id, now);
      const target = it.predict(0);
      const from = cur && distKm([cur.lng, cur.lat], [target.lng, target.lat]) <= MAX_BLEND_KM ? cur : null;
      const fromKm = from && it.predict.onPath ? it.predict.onPath.project(from) : null;
      // A train on a track either glides along it or jumps; it never slides across to another line.
      next.set(it.id, { from: it.predict.onPath && fromKm == null ? null : from, start: now, predict: it.predict, key: it.key, fromKm });
    }
    this.tracks = next;
  }

  has(id: string) { return this.tracks.has(id); }
  ids() { return [...this.tracks.keys()]; }

  pose(id: string, now: number): Pose | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const el = now - tr.start;
    const p = tr.predict(el);
    if (!tr.from || el >= BLEND_MS) return p;
    const k = smooth(el / BLEND_MS);
    // On the same track: glide along it, not across the corridor in a straight line.
    if (tr.fromKm != null && tr.predict.onPath && p.pathKm != null) return tr.predict.onPath.at(tr.fromKm + (p.pathKm - tr.fromKm) * k);
    return { ...p, lng: tr.from.lng + (p.lng - tr.from.lng) * k, lat: tr.from.lat + (p.lat - tr.from.lat) * k };
  }
}

/** Minimum gap between GeoJSON source updates, ms (10 fps). */
export const FRAME_MS = 100;
/** True when a capped-rate loop should do work this frame. */
export function due(last: number, now: number, every = FRAME_MS): boolean {
  return now - last >= every;
}

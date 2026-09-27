/**
 * Snapping trains onto OSM railway geometry. GTFS shapes (especially Sydney Trains') are coarse and can sit tens of
 * metres off the rails, and realtime-only vehicles have no shape at all, so carriages drawn from them cut across the
 * corridor. Here the OSM `railway=rail` ways become a graph of vertices (ways meeting at a shared node are joined);
 * a train's lead is snapped to the nearest track, and the track is walked back (for the carriages) and ahead (for
 * motion between polls), choosing at each junction the branch that best follows the GTFS shape, else the straightest.
 * Pure; no I/O.
 */
// SHARED BY COPY: web/src/map/trackSnap.ts must stay byte-identical to this file (web/test/trackSnap.test.ts checks).
// No imports, so both sides can use it as-is.

type LngLat = [number, number];

const DEG_KM = 111.32;

function cumulativeKm(coords: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    const [lng0, lat0] = coords[i - 1];
    const [lng1, lat1] = coords[i];
    const k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((lng1 - lng0) * DEG_KM * k, (lat1 - lat0) * DEG_KM));
  }
  return out;
}

function bearingDeg(a: LngLat, b: LngLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}
/** Lead positions further than this from any track aren't snapped. */
export const SNAP_MAX_KM = 0.06;
/** A branch turning more sharply than this at a vertex isn't one a train can take. */
const MAX_TURN_DEG = 60;
const CELL_DEG = 0.002; // ~200 m grid cells for the segment index

export interface TrackGraph {
  pts: LngLat[];
  adj: number[][];
  /** Grid cell key -> segments [a, b] (vertex indices) passing through it. */
  grid: Map<string, [number, number][]>;
}

const vkey = (p: LngLat) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
const ckey = (x: number, y: number) => `${x},${y}`;

/**
 * Build the graph from rail lines ([lng, lat] coordinate lists). With `mergeKm`, vertices closer than that are joined
 * too (not just identical ones): lines cut at vector-tile edges end a fraction of a metre apart, and this stitches them.
 */
export function buildTrackGraph(lines: { coords: LngLat[] }[], opts: { mergeKm?: number } = {}): TrackGraph {
  const pts: LngLat[] = [];
  const adj: number[][] = [];
  const ids = new Map<string, number>();
  const grid = new Map<string, [number, number][]>();
  const mergeKm = opts.mergeKm ?? 0;
  const mDeg = mergeKm / DEG_KM; // merge-cell size in degrees of latitude (cells are wider than needed in lng: fine)
  const near = new Map<string, number[]>();
  const vid = (p: LngLat) => {
    const k = vkey(p);
    let i = ids.get(k);
    if (i != null) return i;
    if (mergeKm > 0) {
      const [cx, cy] = [Math.floor(p[0] / mDeg), Math.floor(p[1] / mDeg)];
      let best = -1; let bd = mergeKm;
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
        for (const j of near.get(ckey(x, y)) ?? []) {
          const [dx, dy] = toKm(pts[j], p);
          const d = Math.hypot(dx, dy);
          if (d <= bd) { bd = d; best = j; }
        }
      }
      if (best >= 0) { ids.set(k, best); return best; }
    }
    i = pts.length; ids.set(k, i); pts.push([p[0], p[1]]); adj.push([]);
    if (mergeKm > 0) {
      const ck = ckey(Math.floor(p[0] / mDeg), Math.floor(p[1] / mDeg));
      const l = near.get(ck) ?? []; l.push(i); near.set(ck, l);
    }
    return i;
  };
  for (const { coords } of lines) {
    for (let j = 1; j < coords.length; j++) {
      const a = vid(coords[j - 1]);
      const b = vid(coords[j]);
      if (a === b || adj[a].includes(b)) continue;
      adj[a].push(b); adj[b].push(a);
      const [x0, x1] = [Math.floor(Math.min(pts[a][0], pts[b][0]) / CELL_DEG), Math.floor(Math.max(pts[a][0], pts[b][0]) / CELL_DEG)];
      const [y0, y1] = [Math.floor(Math.min(pts[a][1], pts[b][1]) / CELL_DEG), Math.floor(Math.max(pts[a][1], pts[b][1]) / CELL_DEG)];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = ckey(x, y);
        const list = grid.get(k) ?? [];
        list.push([a, b]);
        grid.set(k, list);
      }
    }
  }
  return { pts, adj, grid };
}

/** Local km coordinates of b relative to a. */
function toKm(a: LngLat, b: LngLat): [number, number] {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return [(b[0] - a[0]) * DEG_KM * k, (b[1] - a[1]) * DEG_KM];
}

function projectSeg(p: LngLat, a: LngLat, b: LngLat): { t: number; offKm: number; pt: LngLat } {
  const [bx, by] = toKm(a, b);
  const [px, py] = toKm(a, p);
  const L2 = bx * bx + by * by;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / L2));
  return { t, offKm: Math.hypot(px - t * bx, py - t * by), pt: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
}

/** Nearest track segment to `p` within `maxKm`. */
export function nearestSegment(g: TrackGraph, p: LngLat, maxKm = SNAP_MAX_KM): { a: number; b: number; pt: LngLat; offKm: number } | null {
  const cx = Math.floor(p[0] / CELL_DEG);
  const cy = Math.floor(p[1] / CELL_DEG);
  let best: { a: number; b: number; pt: LngLat; offKm: number } | null = null;
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    for (const [a, b] of g.grid.get(ckey(x, y)) ?? []) {
      const pr = projectSeg(p, g.pts[a], g.pts[b]);
      if (pr.offKm <= maxKm && (!best || pr.offKm < best.offKm)) best = { a, b, pt: pr.pt, offKm: pr.offKm };
    }
  }
  return best;
}

const angDiff = (x: number, y: number) => { const d = Math.abs(((x - y) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

/** Distance (km) from p to a polyline, brute force (shapes near a train are short enough). */
function distToLine(line: LngLat[], p: LngLat): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, projectSeg(p, line[i - 1], line[i]).offKm);
  return best;
}

/**
 * Walk the graph from `start` (a point on segment prev->cur, travelling towards `cur`) for `km`, returning the points
 * passed (not including `start`). At a vertex with several onward branches it takes the one whose far end lies
 * closest to `guide` (when given and near), else the one turning least; branches turning past MAX_TURN_DEG are dead.
 */
function walk(g: TrackGraph, start: LngLat, prev: number, cur: number, km: number, guide: LngLat[] | null): LngLat[] {
  const out: LngLat[] = [];
  let here = start;
  let left = km;
  let from = prev;
  let at = cur;
  for (let guard = 0; guard < 10_000; guard++) {
    const target = g.pts[at];
    const [dx, dy] = toKm(here, target);
    const d = Math.hypot(dx, dy);
    if (d >= left) {
      const t = d === 0 ? 0 : left / d;
      out.push([here[0] + t * (target[0] - here[0]), here[1] + t * (target[1] - here[1])]);
      return out;
    }
    out.push(target);
    left -= d;
    const inBrg = bearingDeg(g.pts[from], target);
    const options = g.adj[at].filter((n) => n !== from && angDiff(bearingDeg(target, g.pts[n]), inBrg) <= MAX_TURN_DEG);
    if (!options.length) return out; // end of the line
    let next = options[0];
    if (options.length > 1) {
      const score = (n: number) => {
        const turn = angDiff(bearingDeg(target, g.pts[n]), inBrg);
        if (guide) {
          // Look a little way down the branch, so short junction segments don't decide on their first metres.
          const probe = walkProbe(g, at, n, 0.08);
          const off = distToLine(guide, probe);
          if (off < 0.2) return off * 1000 + turn * 0.01;
        }
        return 1e6 + turn;
      };
      next = options.reduce((bst, n) => (score(n) < score(bst) ? n : bst));
    }
    here = target; from = at; at = next;
  }
  return out;
}

/** The point roughly `km` down a branch (straightest continuation), for scoring junction choices. */
function walkProbe(g: TrackGraph, from: number, to: number, km: number): LngLat {
  let [f, t] = [from, to];
  let left = km;
  for (let i = 0; i < 50; i++) {
    const [dx, dy] = toKm(g.pts[f], g.pts[t]);
    const d = Math.hypot(dx, dy);
    if (d >= left) { const k = d ? left / d : 0; return [g.pts[f][0] + k * (g.pts[t][0] - g.pts[f][0]), g.pts[f][1] + k * (g.pts[t][1] - g.pts[f][1])]; }
    left -= d;
    const inBrg = bearingDeg(g.pts[f], g.pts[t]);
    const opts = g.adj[t].filter((n) => n !== f);
    if (!opts.length) return g.pts[t];
    const n = opts.reduce((b, n2) => (angDiff(bearingDeg(g.pts[t], g.pts[n2]), inBrg) < angDiff(bearingDeg(g.pts[t], g.pts[b]), inBrg) ? n2 : b));
    [f, t] = [t, n];
  }
  return g.pts[t];
}

export interface SnappedPath { path: LngLat[]; atKm: number; lat: number; lng: number; bearing: number }

/**
 * Snap a train to the track: `lead` [lng, lat], direction from `bearing` (compass degrees) or failing that the
 * `shape` (the trip's GTFS shape near the train, in travel order). Returns a polyline in the direction of travel with
 * the lead at `atKm`, or null when there's no track within SNAP_MAX_KM or no way to tell direction.
 */
export function snapToTrack(
  g: TrackGraph, lead: LngLat,
  opts: { bearing?: number | null; shape?: LngLat[] | null; backKm: number; aheadKm: number; maxKm?: number },
): SnappedPath | null {
  const seg = nearestSegment(g, lead, opts.maxKm ?? SNAP_MAX_KM);
  if (!seg) return null;
  const shape = opts.shape && opts.shape.length >= 2 ? opts.shape : null;
  let dir = opts.bearing ?? null;
  if (dir == null && shape) {
    // The shape's direction where it passes the train.
    let bi = 1; let bd = Infinity;
    for (let i = 1; i < shape.length; i++) {
      const d = projectSeg(lead, shape[i - 1], shape[i]).offKm;
      if (d < bd && (shape[i][0] !== shape[i - 1][0] || shape[i][1] !== shape[i - 1][1])) { bd = d; bi = i; }
    }
    dir = bearingDeg(shape[bi - 1], shape[bi]);
  }
  if (dir == null) return null;
  const segBrg = bearingDeg(g.pts[seg.a], g.pts[seg.b]);
  const [back, fwd] = angDiff(segBrg, dir) <= 90 ? [seg.a, seg.b] : [seg.b, seg.a];
  const ahead = walk(g, seg.pt, back, fwd, opts.aheadKm, shape);
  const behind = walk(g, seg.pt, fwd, back, opts.backKm, shape ? [...shape].reverse() : null);
  const path: LngLat[] = [...behind.reverse(), seg.pt, ...ahead];
  // Drop consecutive duplicates (the snap point can coincide with a vertex).
  const clean = path.filter((p, i) => i === 0 || p[0] !== path[i - 1][0] || p[1] !== path[i - 1][1]);
  if (clean.length < 2) return null;
  const atIdx = clean.findIndex((p) => p[0] === seg.pt[0] && p[1] === seg.pt[1]);
  const cum = cumulativeKm(clean);
  const i = Math.max(0, atIdx);
  const brgPair = i < clean.length - 1 ? [clean[i], clean[i + 1]] : [clean[i - 1], clean[i]];
  return { path: clean, atKm: cum[i], lat: seg.pt[1], lng: seg.pt[0], bearing: bearingDeg(brgPair[0], brgPair[1]) };
}

/**
 * Clip a polyline to a lng/lat box (Liang-Barsky per segment), returning the pieces inside. Vector tiles carry a
 * buffer of geometry past their edges; clipping each tile's lines to the tile itself stops neighbouring tiles'
 * overlapping copies becoming parallel duplicate track.
 */
export function clipLine(coords: LngLat[], b: { west: number; south: number; east: number; north: number }): LngLat[][] {
  const out: LngLat[][] = [];
  let cur: LngLat[] = [];
  const flush = () => { if (cur.length >= 2) out.push(cur); cur = []; };
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1]; const [x1, y1] = coords[i];
    const dx = x1 - x0; const dy = y1 - y0;
    let t0 = 0; let t1 = 1; let ok = true;
    for (const [p, q] of [[-dx, x0 - b.west], [dx, b.east - x0], [-dy, y0 - b.south], [dy, b.north - y0]] as [number, number][]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { flush(); continue; }
    const a: LngLat = t0 === 0 ? coords[i - 1] : [x0 + t0 * dx, y0 + t0 * dy];
    const e: LngLat = t1 === 1 ? coords[i] : [x0 + t1 * dx, y0 + t1 * dy];
    const last = cur.at(-1);
    if (!last || last[0] !== a[0] || last[1] !== a[1]) { flush(); cur.push(a); }
    cur.push(e);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

/** Where a lng/lat point lies along a polyline (km) and how far off it is; for reusing a snapped path. */
export function projectOnPath(path: LngLat[], p: LngLat): { atKm: number; offKm: number } | null {
  if (path.length < 2) return null;
  const cum = cumulativeKm(path);
  let best: { atKm: number; offKm: number } | null = null;
  for (let i = 1; i < path.length; i++) {
    const pr = projectSeg(p, path[i - 1], path[i]);
    if (!best || pr.offKm < best.offKm) best = { atKm: cum[i - 1] + pr.t * (cum[i] - cum[i - 1]), offKm: pr.offKm };
  }
  return best;
}

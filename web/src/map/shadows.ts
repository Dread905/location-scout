import { difference, union, type Geom } from 'polyclip-ts';

/** Building shadow geometry. Pure: the map layer feeds it footprints from queryRenderedFeatures. */

type Pt = [number, number];

export const MIN_SHADOW_ALT = 5; // degrees; lower and shadows streak across the whole view
export const MAX_SHADOW_M = 200; // metres; a hard cap on top of the altitude floor
export const DEFAULT_HEIGHT = 6; // metres, for buildings with no height tag

/** Shadow length in metres for a height and sun altitude, with the altitude floored at MIN_SHADOW_ALT and the length capped at MAX_SHADOW_M. */
export function shadowLength(heightM: number, altDeg: number): number {
  return Math.min(MAX_SHADOW_M, heightM / Math.tan((Math.max(altDeg, MIN_SHADOW_ALT) * Math.PI) / 180));
}

/** Convex hull (Andrew's monotone chain), returned as a closed ring. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return [...pts, pts[0]];
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return [...hull, hull[0]];
}

/** Offset in degrees [dLng, dLat] for a shadow of `lengthM` cast away from a sun at `sunAz`, at latitude `lat`. */
export function shadowOffset(lengthM: number, sunAz: number, lat: number): Pt {
  const away = ((sunAz + 180) * Math.PI) / 180;
  const east = lengthM * Math.sin(away);
  const north = lengthM * Math.cos(away);
  return [east / (111_320 * Math.cos((lat * Math.PI) / 180)), north / 110_540];
}

/** A footprint ring [lng, lat] and the shadow it casts, as a closed ring. */
export function shadowPolygon(ring: Pt[], heightM: number, sunAz: number, sunAlt: number): Pt[] {
  const [dx, dy] = shadowOffset(shadowLength(heightM, sunAlt), sunAz, ring[0][1]);
  // Exact for convex footprints; buildingShadows cuts every footprint back out, so concave ones read right too.
  return convexHull([...ring, ...ring.map(([x, y]): Pt => [x + dx, y + dy])]);
}

export interface Footprint {
  id?: string | number;
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown> | null;
}

/**
 * Shadows for building footprints (Polygon or MultiPolygon; outer rings only) as one MultiPolygon:
 * every shadow unioned, so overlaps don't darken, then every footprint cut out, so a shadow stops at
 * the base of the next building instead of running on beneath it.
 */
export function buildingShadows(features: Footprint[], sunAz: number, sunAlt: number): GeoJSON.FeatureCollection {
  const shadows: Geom[] = [];
  const footprints: Geom[] = [];
  for (const f of features) {
    const h = Number(f.properties?.render_height ?? f.properties?.height ?? DEFAULT_HEIGHT) || DEFAULT_HEIGHT;
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as Pt[][][];
    for (const poly of polys) {
      if (!poly[0] || poly[0].length < 4) continue;
      shadows.push([shadowPolygon(poly[0], h, sunAz, sunAlt)]);
      footprints.push([poly[0]]);
    }
  }
  if (!shadows.length) return { type: 'FeatureCollection', features: [] };
  // Union only hulls that can touch: group by overlapping bounding boxes (union-find), then union and cut
  // each group on its own with just the footprints inside its bbox. Same result as one global union, but
  // polyclip's sweep stays small instead of growing with every building on screen.
  const bb = shadows.map((g) => bbox(g[0] as Pt[]));
  const fb = footprints.map((g) => bbox(g[0] as Pt[]));
  const parent = shadows.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const order = bb.map((_, i) => i).sort((a, b) => bb[a][0] - bb[b][0]);
  const active: number[] = [];
  for (const i of order) {
    let k = 0;
    for (const j of active) {
      if (bb[j][2] < bb[i][0]) continue; // swept past
      active[k++] = j;
      if (overlaps(bb[i], bb[j])) parent[find(i)] = find(j);
    }
    active.length = k;
    active.push(i);
  }
  const groups = new Map<number, number[]>();
  shadows.forEach((_, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); });
  const coordinates: Pt[][][] = [];
  for (const idx of groups.values()) {
    const box = idx.reduce<Box>((a, i) => [Math.min(a[0], bb[i][0]), Math.min(a[1], bb[i][1]), Math.max(a[2], bb[i][2]), Math.max(a[3], bb[i][3])] as Box, [Infinity, Infinity, -Infinity, -Infinity]);
    const cut = footprints.filter((_, j) => overlaps(box, fb[j]));
    try {
      const u = idx.length === 1 ? shadows[idx[0]] : union(shadows[idx[0]], ...idx.slice(1).map((i) => shadows[i]));
      coordinates.push(...(cut.length ? difference(u, ...cut) : idx.length === 1 ? [u] : u) as Pt[][][]);
    } catch {
      coordinates.push(...idx.map((i) => shadows[i] as Pt[][])); // degenerate input: separate hulls beat no shadows at all
    }
  }
  if (!coordinates.length) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates } }] };
}

type Box = [number, number, number, number];
function bbox(ring: Pt[]): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
}
const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

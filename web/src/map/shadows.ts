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
  let coordinates: Pt[][][];
  try {
    coordinates = difference(union(shadows[0], ...shadows.slice(1)), ...footprints) as Pt[][][];
  } catch {
    coordinates = shadows as Pt[][][]; // degenerate input: separate hulls beat no shadows at all
  }
  if (!coordinates.length) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates } }] };
}

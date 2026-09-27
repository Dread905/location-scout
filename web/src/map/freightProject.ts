/**
 * Client copy of server/src/feeds/freight.ts's line projection, so the ghost
 * marker can be recomputed locally as the time slider scrubs, no round trip.
 * Kept in sync by hand (separate workspaces) — see that file for comments.
 */
export interface LatLng { lat: number; lng: number }

const DEG_KM = 111.32;
function toXY(lat: number, lng: number, refLat: number): [number, number] {
  return [lng * DEG_KM * Math.cos((refLat * Math.PI) / 180), lat * DEG_KM];
}
function fromXY(x: number, y: number, refLat: number): LatLng {
  return { lat: y / DEG_KM, lng: x / (DEG_KM * Math.cos((refLat * Math.PI) / 180)) };
}

function buildLineGeom(coords: [number, number][]) {
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

export function projectOntoLine(coords: [number, number][], point: LatLng): { atKm: number; offKm: number } | null {
  if (coords.length < 2) return null;
  const g = buildLineGeom(coords);
  const [px, py] = toXY(point.lat, point.lng, g.refLat);
  let best: { atKm: number; offKm: number } | null = null;
  for (let i = 1; i < g.xy.length; i++) {
    const [ax, ay] = g.xy[i - 1];
    const [bx, by] = g.xy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || off < best.offKm) best = { atKm: g.cum[i - 1] + t * Math.hypot(dx, dy), offKm: off };
  }
  return best;
}

function pointAtDistanceOnLine(coords: [number, number][], atKm: number): LatLng {
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

/** Only 'up'/'down' sightings can be projected — a bearing-only sighting has no line to walk. */
export function projectAlongLine(coords: [number, number][], startPoint: LatLng, direction: string, speedKmh: number, minutes: number): LatLng | null {
  if (direction !== 'up' && direction !== 'down') return null;
  const start = projectOntoLine(coords, startPoint);
  if (!start) return null;
  const deltaKm = (speedKmh * minutes) / 60;
  return pointAtDistanceOnLine(coords, start.atKm + (direction === 'up' ? deltaKm : -deltaKm));
}

/** Small spherical helpers. Pure; no MapLibre, no DOM. */

const R = 6371; // km
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** The [lng, lat] reached going `km` from a point on `bearing` (degrees clockwise from north). */
export function destination(lat: number, lng: number, bearing: number, km: number): [number, number] {
  const d = km / R;
  const b = rad(bearing);
  const la1 = rad(lat);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = rad(lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

/** Initial bearing from one point to another, 0-360. */
export function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest difference between two angles, -180..180. */
export function angleDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/** A facing wedge (field-of-view sector) as a closed [lng, lat] ring. */
export function wedge(lat: number, lng: number, facing: number, fov: number, km: number): [number, number][] {
  const ring: [number, number][] = [[lng, lat]];
  const steps = 12;
  for (let i = 0; i <= steps; i++) ring.push(destination(lat, lng, facing - fov / 2 + (fov * i) / steps, km));
  ring.push([lng, lat]);
  return ring;
}

/** Mean of a ring's vertices: good enough as a label/centre point for a place outline. */
export function centroid(coords: [number, number][]): [number, number] {
  const pts = coords.length > 1 && coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1] ? coords.slice(0, -1) : coords;
  const sum = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

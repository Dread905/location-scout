/** haversine distance and bbox helpers, from event-scout's density/geo.ts. */

export const M_PER_DEG_LAT = 111320;

export interface Bbox { south: number; west: number; north: number; east: number }

export function mPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** A radius in km around a point, as a lat/lon box. */
export function bboxFromRadius(lat: number, lon: number, radiusKm: number): Bbox {
  const dLat = (radiusKm * 1000) / M_PER_DEG_LAT;
  const dLon = (radiusKm * 1000) / mPerDegLon(lat);
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

export function inBbox(b: Bbox, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Parse `"south,west,north,east"`. Throws on anything else. */
export function parseBbox(raw: string): Bbox {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new Error('bbox must be "south,west,north,east"');
  const [south, west, north, east] = parts;
  return { south, west, north, east };
}

/** Parse `"lat,lng"`. Throws on anything else. */
export function parseLatLng(raw: string): { lat: number; lng: number } {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) throw new Error('near must be "lat,lng"');
  const [lat, lng] = parts;
  return { lat, lng };
}

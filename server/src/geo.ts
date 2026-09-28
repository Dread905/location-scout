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

export const DEFAULT_MAX_TILE_KM = 50;

/**
 * Splits a bounding box into smaller bounded tiles if either dimension exceeds maxTileKm.
 * Tiles cover the original bounding box completely without gaps, ordered sequentially.
 */
export function tileBbox(bbox: Bbox, maxTileKm = DEFAULT_MAX_TILE_KM): Bbox[] {
  const midLat = (bbox.south + bbox.north) / 2;
  const heightKm = ((bbox.north - bbox.south) * M_PER_DEG_LAT) / 1000;
  const widthKm = ((bbox.east - bbox.west) * mPerDegLon(midLat)) / 1000;

  const numTilesY = Math.max(1, Math.ceil(heightKm / maxTileKm));
  const numTilesX = Math.max(1, Math.ceil(widthKm / maxTileKm));

  if (numTilesX === 1 && numTilesY === 1) {
    return [bbox];
  }

  const stepLat = (bbox.north - bbox.south) / numTilesY;
  const stepLon = (bbox.east - bbox.west) / numTilesX;

  const tiles: Bbox[] = [];
  for (let y = 0; y < numTilesY; y++) {
    const south = bbox.south + y * stepLat;
    const north = y === numTilesY - 1 ? bbox.north : bbox.south + (y + 1) * stepLat;
    for (let x = 0; x < numTilesX; x++) {
      const west = bbox.west + x * stepLon;
      const east = x === numTilesX - 1 ? bbox.east : bbox.west + (x + 1) * stepLon;
      tiles.push({ south, north, west, east });
    }
  }
  return tiles;
}

/**
 * Generates bounded tiles covering a circular radius around a point.
 */
export function tileArea(lat: number, lon: number, radiusKm: number, maxTileKm = DEFAULT_MAX_TILE_KM): Bbox[] {
  const bbox = bboxFromRadius(lat, lon, radiusKm);
  return tileBbox(bbox, maxTileKm);
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

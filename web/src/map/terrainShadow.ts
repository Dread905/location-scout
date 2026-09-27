/** Cast terrain shadows: a pure ray-march over an elevation grid (no DOM, testable in node). */

export const TERRAIN_SHADOW_MAX_M = 5000; // shadow rays stop here, so tiles need only one ring of neighbours
export const TERRAIN_SHADOW_MIN_ALT = 3; // degrees; lower sun is treated as 3°

export type Grid = { data: Float32Array; width: number; height: number };

/**
 * Shadow mask for the `w`×`h` window at (`x0`, `y0`) of `grid`: 1 where the ground is shaded, either because
 * the slope faces away from the sun (self-shadow) or because terrain towards the sun rises above the sun line
 * (cast shadow). Azimuth is degrees clockwise from north; grid x runs east, y runs south.
 */
export function shadowMask(
  grid: Grid, mPerPx: number, azimuth: number, altitude: number,
  win: { x0: number; y0: number; w: number; h: number } = { x0: 0, y0: 0, w: grid.width, h: grid.height },
  maxM = TERRAIN_SHADOW_MAX_M,
): Uint8Array {
  const { data, width, height } = grid;
  const out = new Uint8Array(win.w * win.h);
  if (altitude <= 0) return out.fill(1);
  const alt = Math.max(altitude, TERRAIN_SHADOW_MIN_ALT);
  if (alt >= 90) return out;
  const az = (azimuth * Math.PI) / 180;
  const dx = Math.sin(az), dy = -Math.cos(az);
  const rise = Math.tan((alt * Math.PI) / 180) * mPerPx; // sun-line rise per pixel stepped
  const steps = Math.max(1, Math.floor(maxM / mPerPx));
  const at = (x: number, y: number) => {
    const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
    return data[yi * width + xi];
  };
  for (let j = 0; j < win.h; j++) {
    for (let i = 0; i < win.w; i++) {
      const x = win.x0 + i, y = win.y0 + j;
      const e0 = data[y * width + x];
      // Self-shadow: the ground's rise towards the sun (central difference) beats the sun line.
      const slope = (at(x + dx, y + dy) - at(x - dx, y - dy)) / 2;
      let shaded = slope > rise;
      for (let s = 1; !shaded && s <= steps; s++) {
        const px = x + dx * s, py = y + dy * s;
        if (px < 0 || py < 0 || px > width - 1 || py > height - 1) break;
        if (at(px, py) - e0 > rise * s) shaded = true;
      }
      if (shaded) out[j * win.w + i] = 1;
    }
  }
  return out;
}

/** Terrarium RGB to metres. */
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const n = rgba.length / 4, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return out;
}

/** Ground metres per pixel of a 256px web-mercator tile at zoom `z`, tile row `y`. */
export function tileMetresPerPixel(z: number, y: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  const lat = Math.atan(Math.sinh(n));
  return (40_075_016.7 * Math.cos(lat)) / (256 * 2 ** z);
}

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TILE = 256;

/** Nine 256² DEM tiles (row-major, centre at 4) into one 768² grid; a missing neighbour reuses the centre. */
export function stitch3x3(tiles: (Float32Array | null)[]): Grid | null {
  const centre = tiles[4];
  if (!centre) return null;
  const W = 3 * TILE, data = new Float32Array(W * W);
  tiles.forEach((t, k) => {
    const src = t ?? centre;
    const ox = (k % 3) * TILE, oy = Math.floor(k / 3) * TILE;
    for (let r = 0; r < TILE; r++) data.set(src.subarray(r * TILE, r * TILE + TILE), (oy + r) * W + ox);
  });
  return { data, width: W, height: W };
}

/** Web-mercator world pixel [x, y] of a lng/lat at zoom `z` (256px tiles). */
export function worldPx(lng: number, lat: number, z: number): [number, number] {
  const s = TILE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
}

/** lng/lat bbox [w, s, e, n] of tile z/x/y. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

type Ring = [number, number][];
/**
 * Rings of the polygons in `fc` (lng/lat) that touch tile z/x/y, in that tile's pixel space (0..256, can overrun).
 * Holes come along as plain rings: `fillRings` is even-odd, so they stay unfilled.
 */
export function tileRings(fc: GeoJSON.FeatureCollection, z: number, x: number, y: number): Ring[] {
  const [w, s, e, n] = tileBounds(z, x, y);
  const out: Ring[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [lx, ly] of ring) { x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); y0 = Math.min(y0, ly); y1 = Math.max(y1, ly); }
      if (x1 < w || x0 > e || y1 < s || y0 > n) continue;
      out.push(ring.map(([lx, ly]) => { const [px, py] = worldPx(lx, ly, z); return [px - x * TILE, py - y * TILE] as [number, number]; }));
    }
  }
  return out;
}

/** Scanline-fill `rings` (even-odd, sampled at pixel centres) into `mask` (w×h) as 1s. OR: never clears a pixel. */
export function fillRings(mask: Uint8Array, w: number, h: number, rings: Ring[]): Uint8Array {
  const xs: number[] = [];
  for (let j = 0; j < h; j++) {
    const cy = j + 0.5;
    xs.length = 0;
    for (const r of rings) for (let k = 0; k < r.length - 1; k++) {
      const [ax, ay] = r[k], [bx, by] = r[k + 1];
      if ((ay <= cy) !== (by <= cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * w + i] = 1;
    }
  }
  return mask;
}

/**
 * The 256² window of a zoom-`z` tile cut from its ancestor's 256² mask at zoom `z - dz` (tile offset `ox`, `oy` in
 * child tiles within that ancestor), bilinearly sampled and thresholded at 0.5 so edges stay smooth, not blocky.
 */
export function upsampleMask(parent: Uint8Array, dz: number, ox: number, oy: number): Uint8Array {
  const k = 2 ** dz, out = new Uint8Array(TILE * TILE);
  const at = (x: number, y: number) => parent[Math.min(TILE - 1, Math.max(0, y)) * TILE + Math.min(TILE - 1, Math.max(0, x))];
  for (let j = 0; j < TILE; j++) {
    const py = (oy * TILE + j + 0.5) / k - 0.5, y0 = Math.floor(py), fy = py - y0;
    for (let i = 0; i < TILE; i++) {
      const px = (ox * TILE + i + 0.5) / k - 0.5, x0 = Math.floor(px), fx = px - x0;
      const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      if (v >= 0.5) out[j * TILE + i] = 1;
    }
  }
  return out;
}

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

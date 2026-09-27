/** Browser side of Plan shoot's terrain shade: the z12 DEM block around a point, fetched and decoded like the map's shadow tiles. */
import { decodeTerrarium, stitch3x3, TERRARIUM_URL, TILE, tileMetresPerPixel, worldPx } from './terrainShadow.js';
import { terrainShadeAt, type ShadeTest } from './shootPlan.js';

const Z = 12;

async function tile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  x = ((x % n) + n) % n;
  try {
    const res = await fetch(TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, TILE, TILE);
    bmp.close();
    return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
  } catch { return null; }
}

/** Terrain shade test for a point, or null when its DEM tile can't be had. */
export async function terrainShadeForPoint(lat: number, lng: number): Promise<ShadeTest | null> {
  const [wx, wy] = worldPx(lng, lat, Z);
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  const grid = stitch3x3(await Promise.all([-1, 0, 1].flatMap((j) => [-1, 0, 1].map((i) => tile(Z, tx + i, ty + j)))));
  if (!grid) return null;
  return terrainShadeAt(grid, tileMetresPerPixel(Z, ty), Math.min(3 * TILE - 1, wx - (tx - 1) * TILE), Math.min(3 * TILE - 1, wy - (ty - 1) * TILE));
}

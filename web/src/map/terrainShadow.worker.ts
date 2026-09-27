/// <reference lib="webworker" />
/**
 * Renders shadow tiles off the main thread: terrain (a 3×3 block of Terrarium DEM tiles, ray-marched) OR'ed with
 * building shadow polygons into one mask, encoded as a PNG in one colour. One mask means one opacity: a building
 * shadow inside terrain shadow doesn't darken it further.
 */
import { decodeTerrarium, fillRings, shadowMask, stitch3x3, TERRARIUM_URL, TILE as T, tileMetresPerPixel, upsampleMask } from './terrainShadow.js';

const cache = new Map<string, Promise<Float32Array | null>>(); // LRU by insertion order
const CACHE_MAX = 200;
const DEM_MAX_Z = 12; // above this, cut the terrain mask from the z12 ancestor (DEM detail doesn't help, cost would)

function lru<V>(m: Map<string, V>, key: string, max: number, make: () => V): V {
  const hit = m.get(key);
  if (hit !== undefined) { m.delete(key); m.set(key, hit); return hit; }
  const v = make();
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value!);
  return v;
}

function dem(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  return lru(cache, key, CACHE_MAX, () => (async () => {
    try {
      const res = await fetch(TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const ctx = new OffscreenCanvas(T, T).getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, T, T);
      bmp.close();
      return decodeTerrarium(ctx.getImageData(0, 0, T, T).data);
    } catch { cache.delete(key); return null; }
  })());
}

const masks = new Map<string, Promise<Uint8Array | null>>();
function terrainMask(z: number, x: number, y: number, az: number, alt: number): Promise<Uint8Array | null> {
  return lru(masks, `${z}/${x}/${y}/${az}/${alt}`, 64, async () => {
    const grid = stitch3x3(await Promise.all([-1, 0, 1].flatMap((j) => [-1, 0, 1].map((i) => dem(z, x + i, y + j)))));
    return grid && shadowMask(grid, tileMetresPerPixel(z, y), az, alt, { x0: T, y0: T, w: T, h: T });
  });
}

export type ShadowRequest = {
  id: number; z: number; x: number; y: number; az: number; alt: number; color: [number, number, number];
  terrain: boolean; rings: [number, number][][]; // building shadow rings in this tile's pixel space
};

async function render({ z, x, y, az, alt, color, terrain, rings }: ShadowRequest): Promise<ArrayBuffer> {
  let mask: Uint8Array = new Uint8Array(T * T);
  if (terrain) {
    const dz = Math.max(0, z - DEM_MAX_Z), k = 2 ** dz;
    const px = Math.floor(x / k), py = Math.floor(y / k);
    const parent = await terrainMask(z - dz, px, py, az, alt);
    if (parent) mask = dz ? upsampleMask(parent, dz, x - px * k, y - py * k) : parent.slice();
  }
  if (rings.length) fillRings(mask, T, T, rings);
  const canvas = new OffscreenCanvas(T, T);
  const img = new ImageData(T, T);
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    img.data[i * 4] = color[0]; img.data[i * 4 + 1] = color[1]; img.data[i * 4 + 2] = color[2]; img.data[i * 4 + 3] = 255;
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

self.onmessage = async (e: MessageEvent<ShadowRequest>) => {
  try {
    const buf = await render(e.data);
    (self as unknown as Worker).postMessage({ id: e.data.id, buf }, [buf]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, error: String(err) });
  }
};

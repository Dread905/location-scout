/// <reference lib="webworker" />
/** Renders cast terrain shadow tiles off the main thread: fetch a 3×3 block of Terrarium DEM tiles, ray-march, encode PNG. */
import { decodeTerrarium, shadowMask, tileMetresPerPixel } from './terrainShadow.js';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const T = 256;
const cache = new Map<string, Promise<Float32Array | null>>(); // LRU by insertion order
const CACHE_MAX = 200;

function dem(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const p = (async () => {
    try {
      const res = await fetch(TERRARIUM.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const ctx = new OffscreenCanvas(T, T).getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, T, T);
      bmp.close();
      return decodeTerrarium(ctx.getImageData(0, 0, T, T).data);
    } catch { cache.delete(key); return null; }
  })();
  cache.set(key, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

export type ShadowRequest = { id: number; z: number; x: number; y: number; az: number; alt: number; color: [number, number, number] };

async function render({ z, x, y, az, alt, color }: ShadowRequest): Promise<ArrayBuffer> {
  const tiles = await Promise.all([-1, 0, 1].flatMap((j) => [-1, 0, 1].map((i) => dem(z, x + i, y + j))));
  const W = 3 * T, data = new Float32Array(W * W);
  const centre = tiles[4];
  tiles.forEach((t, k) => {
    const src = t ?? centre; // missing neighbour: reuse the centre (edge rays just run short)
    if (!src) return;
    const ox = (k % 3) * T, oy = Math.floor(k / 3) * T;
    for (let r = 0; r < T; r++) data.set(src.subarray(r * T, r * T + T), (oy + r) * W + ox);
  });
  const canvas = new OffscreenCanvas(T, T);
  if (centre) {
    const mask = shadowMask({ data, width: W, height: W }, tileMetresPerPixel(z, y), az, alt, { x0: T, y0: T, w: T, h: T });
    const img = new ImageData(T, T);
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      img.data[i * 4] = color[0]; img.data[i * 4 + 1] = color[1]; img.data[i * 4 + 2] = color[2]; img.data[i * 4 + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(img, 0, 0);
  }
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

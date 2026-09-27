import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrarium, shadowMask, type Grid } from '../src/map/terrainShadow.js';

/** A north–south ridge 200 m high at x=20 on flat ground, 10 m per pixel. */
function ridge(): Grid {
  const width = 60, height = 20, data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = Math.max(0, 200 - Math.abs(x - 20) * 40);
  return { data, width, height };
}
const count = (m: Uint8Array, g: Grid, x0: number, x1: number, y = 10) => { let n = 0; for (let x = x0; x < x1; x++) n += m[y * g.width + x]; return n; };

test('a ridge lit from the east shades the valley to its west, not the east', () => {
  const g = ridge();
  const m = shadowMask(g, 10, 90, 20); // sun due east, 20° up: 200 m ridge throws ~550 m = 55 px, clipped by grid
  assert.equal(count(m, g, 0, 15), 15); // west valley fully shaded
  assert.equal(count(m, g, 21, 60), 0); // east side lit
});

test('sun from the west shades the east side instead', () => {
  const g = ridge();
  const m = shadowMask(g, 10, 270, 20);
  assert.ok(count(m, g, 26, 60) > 20);
  assert.equal(count(m, g, 0, 20), 0);
});

test('no shadow with the sun overhead; all shadow with it below the horizon', () => {
  const g = ridge();
  assert.equal(shadowMask(g, 10, 90, 90).reduce((a, b) => a + b, 0), 0);
  assert.equal(shadowMask(g, 10, 90, -1).reduce((a, b) => a + b, 0), g.width * g.height);
});

test('flat ground is never shaded; windowed output matches', () => {
  const g: Grid = { data: new Float32Array(100), width: 10, height: 10 };
  assert.equal(shadowMask(g, 30, 135, 5).reduce((a, b) => a + b, 0), 0);
  const w = shadowMask(ridge(), 10, 90, 20, { x0: 0, y0: 5, w: 10, h: 2 });
  assert.equal(w.length, 20);
  assert.equal(w.reduce((a, b) => a + b, 0), 20);
});

test('decodeTerrarium', () => {
  assert.deepEqual([...decodeTerrarium(new Uint8Array([128, 0, 0, 255, 128, 100, 128, 255]))], [0, 100.5]);
});

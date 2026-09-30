import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestWindows, buildingShadeAt, lightTimeline, terrainShadeAt } from '../src/map/shootPlan.js';
import { fillRings, stitch3x3, tileBounds, tileRings, upsampleMask, worldPx } from '../src/map/terrainShadow.js';

const LAT = 51.5, LNG = -0.12; // London (test runs in the machine's zone; midsummer keeps phases present anyway)
const DAY = new Date(2026, 5, 21);

test('lightTimeline: night when the sun is down, sun otherwise with no shade tests', () => {
  const s = lightTimeline(DAY, LAT, LNG, {});
  assert.equal(s.length, 144);
  for (const x of s) assert.equal(x.light, x.altitude > 0 ? 'sun' : 'night');
});

test('lightTimeline: morning terrain shade, and buildings only count where terrain is not already shading', () => {
  let bCalls = 0;
  const s = lightTimeline(DAY, LAT, LNG, { terrain: (az) => az < 180, buildings: () => { bCalls++; return true; } });
  const up = s.filter((x) => x.altitude > 0);
  assert.ok(up.every((x) => x.light === 'shade'));
  assert.ok(up.filter((x) => x.azimuth < 180).every((x) => x.terrain && !x.buildings));
  assert.equal(bCalls, up.filter((x) => x.azimuth >= 180).length);
});

test('bestWindows: golden sun and daytime shade runs, merged', () => {
  const lit = lightTimeline(DAY, LAT, LNG, {});
  const w = bestWindows(lit);
  assert.ok(w.length >= 2 && w.every((x) => x.kind === 'golden-sun'));
  assert.ok(w[0].end > w[0].start);
  const shaded = bestWindows(lightTimeline(DAY, LAT, LNG, { buildings: () => true }));
  assert.ok(shaded.length >= 1);
  assert.ok(shaded.every((x) => x.kind === 'even-shade'));
});

test('terrainShadeAt: a ridge to the east shades a point to its west in the morning only', () => {
  const g = { width: 60, height: 20, data: new Float32Array(1200) };
  for (let y = 0; y < 20; y++) for (let x = 0; x < 60; x++) g.data[y * 60 + x] = Math.max(0, 200 - Math.abs(x - 20) * 40);
  const at = terrainShadeAt(g, 10, 10, 10);
  assert.equal(at(90, 20), true);
  assert.equal(at(270, 20), false);
});

test('buildingShadeAt: a tall building south of the spot shades it at noon (northern hemisphere); its own footprint is ignored', () => {
  const d = 0.0001; // ~11 m
  const sq = (cx: number, cy: number) => [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]];
  const south = { geometry: { type: 'Polygon', coordinates: [sq(0, 51.4995)] } as GeoJSON.Polygon, properties: { height: 40 } };
  const shade = buildingShadeAt([south], 0, 51.5);
  assert.equal(shade(180, 40), true);
  assert.equal(shade(0, 40), false);
  const onRoof = buildingShadeAt([{ ...south, geometry: { type: 'Polygon', coordinates: [sq(0, 51.5)] } }], 0, 51.5);
  assert.equal(onRoof(180, 40), false);
});

test('fillRings: even-odd with holes, OR into an existing mask', () => {
  const m = new Uint8Array(100);
  m[0] = 1;
  fillRings(m, 10, 10, [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]);
  assert.equal(m[0], 1); // untouched terrain pixel stays
  assert.equal(m[2 * 10 + 2], 1);
  assert.equal(m[5 * 10 + 5], 0); // hole
  assert.equal(m[5 * 10 + 8], 0);
  assert.equal(m.reduce((a, b) => a + b, 0), 1 + 36 - 4);
});

test('tileRings: projects a polygon into its tile, drops polygons elsewhere', () => {
  const [w, s, e, n] = tileBounds(15, 16372, 10895);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[cx, cy], [e, cy], [e, n], [cx, cy]]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[e + 1, n], [e + 2, n], [e + 2, n + 0.1], [e + 1, n]]] } },
  ] };
  const r = tileRings(fc, 15, 16372, 10895);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0][0][0] - 128) < 1e-6 && Math.abs(r[0][1][0] - 256) < 1e-6 && Math.abs(r[0][2][1]) < 1e-6);
  const [px] = worldPx(-180, 0, 0);
  assert.equal(px, 0);
});

test('upsampleMask: a child tile of a half-shaded parent', () => {
  const parent = new Uint8Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) parent[y * 256 + x] = 1; // west half shaded
  const left = upsampleMask(parent, 1, 0, 0), right = upsampleMask(parent, 1, 1, 0);
  assert.equal(left.reduce((a, b) => a + b, 0), 256 * 256);
  assert.equal(right.reduce((a, b) => a + b, 0), 0);
});

test('stitch3x3: null centre is null; missing neighbours reuse the centre', () => {
  assert.equal(stitch3x3(Array(9).fill(null)), null);
  const c = new Float32Array(256 * 256).fill(7);
  const g = stitch3x3([null, null, null, null, c, null, null, null, null])!;
  assert.equal(g.width, 768);
  assert.equal(g.data[0], 7);
});

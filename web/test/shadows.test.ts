import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingShadows, convexHull, MAX_SHADOW_M, shadowLength, shadowOffset, shadowPolygon } from '../src/map/shadows.js';

test('shadowLength: h / tan(alt), altitude floored at 5 degrees, length capped', () => {
  assert.ok(Math.abs(shadowLength(10, 45) - 10) < 1e-9);
  assert.ok(Math.abs(shadowLength(10, 30) - 10 * Math.sqrt(3)) < 1e-9);
  assert.equal(shadowLength(10, 0.5), shadowLength(10, 5));
  assert.equal(shadowLength(100, 5), MAX_SHADOW_M);
});

test('shadowOffset: a sun due north throws the shadow due south', () => {
  const [dx, dy] = shadowOffset(110_540, 0, 0);
  assert.ok(Math.abs(dx) < 1e-9);
  assert.ok(Math.abs(dy + 1) < 1e-9);
});

test('convexHull: drops interior points, returns a closed ring', () => {
  const hull = convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0.5]]);
  assert.equal(hull.length, 5);
  assert.deepEqual(hull[0], hull.at(-1));
  assert.deepEqual(new Set(hull.slice(0, -1).map(String)), new Set(['0,0', '2,0', '2,2', '0,2']));
});

test('shadowPolygon: footprint plus its projection, stretched away from the sun', () => {
  const square: [number, number][] = [[149.5, -33.4], [149.5001, -33.4], [149.5001, -33.4001], [149.5, -33.4001], [149.5, -33.4]];
  const ring = shadowPolygon(square, 10, 90, 45); // sun due east: a 10 m shadow to the west
  const minLng = Math.min(...ring.map((p) => p[0]));
  const metresWest = (149.5 - minLng) * 111_320 * Math.cos((33.4 * Math.PI) / 180);
  assert.ok(Math.abs(metresWest - 10) < 0.01, `${metresWest}`);
});

type P = [number, number];
const sq = (x: number, y = -33.4, d = 0.0001): P[] => [[x, y], [x + d, y], [x + d, y - d], [x, y - d], [x, y]];
const fp = (ring: P[], height = 20) => ({ geometry: { type: 'Polygon' as const, coordinates: [ring] }, properties: { height } });
const inside = (p: P, ring: P[]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const covered = (p: P, mp: GeoJSON.MultiPolygon) =>
  mp.coordinates.filter((poly) => inside(p, poly[0] as P[]) && !poly.slice(1).some((h) => inside(p, h as P[]))).length;

test('buildingShadows: overlapping shadows merge into one geometry with no double cover', () => {
  // Sun due east: long shadows run west, the east building's across the west one's shadow.
  const fc = buildingShadows([fp(sq(149.5)), fp(sq(149.5002))], 90, 30);
  assert.equal(fc.features.length, 1);
  const g = fc.features[0].geometry as GeoJSON.MultiPolygon;
  assert.equal(g.type, 'MultiPolygon');
  // West of the west building both shadows would overlap; the union covers it exactly once.
  assert.equal(covered([149.4998, -33.40005], g), 1);
});

test('buildingShadows: footprints are cut out, so shadows stop at the next building', () => {
  const g = buildingShadows([fp(sq(149.5)), fp(sq(149.5002))], 90, 30).features[0].geometry as GeoJSON.MultiPolygon;
  assert.equal(covered([149.50005, -33.40005], g), 0); // inside the west building
  assert.equal(covered([149.50025, -33.40005], g), 0); // inside the east (casting) building
  assert.equal(covered([149.50015, -33.40005], g), 1); // the gap between them is in shadow
});

test('buildingShadows: empty input gives no features', () => {
  assert.equal(buildingShadows([], 0, 45).features.length, 0);
});

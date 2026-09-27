import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convexHull, shadowLength, shadowOffset, shadowPolygon } from '../src/map/shadows.js';

test('shadowLength: h / tan(alt), with the altitude floored at 2 degrees', () => {
  assert.ok(Math.abs(shadowLength(10, 45) - 10) < 1e-9);
  assert.ok(Math.abs(shadowLength(10, 30) - 10 * Math.sqrt(3)) < 1e-9);
  assert.equal(shadowLength(10, 0.5), shadowLength(10, 2));
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

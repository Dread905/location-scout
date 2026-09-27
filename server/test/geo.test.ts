import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bboxFromRadius, inBbox, parseBbox, parseLatLng } from '../src/geo.js';

test('haversine: one degree of longitude at the equator is ~111.32km', () => {
  const d = haversine(0, 0, 0, 1);
  assert.ok(Math.abs(d - 111320) < 200, `expected ~111320m, got ${d}`);
});

test('haversine: same point is zero', () => {
  assert.equal(haversine(-33.419, 149.577, -33.419, 149.577), 0);
});

test('bboxFromRadius: a point sits inside its own box', () => {
  const box = bboxFromRadius(-33.419, 149.577, 100);
  assert.ok(inBbox(box, -33.419, 149.577));
});

test('bboxFromRadius: a point far outside the radius sits outside the box', () => {
  const box = bboxFromRadius(-33.419, 149.577, 100); // Bathurst, 100km
  assert.equal(inBbox(box, -33.868, 151.207), false); // Sydney, ~200km away
});

test('parseBbox / parseLatLng: round-trip valid input, reject malformed input', () => {
  assert.deepEqual(parseBbox('-34,149,-33,150'), { south: -34, west: 149, north: -33, east: 150 });
  assert.throws(() => parseBbox('not,a,bbox'));
  assert.deepEqual(parseLatLng('-33.419,149.577'), { lat: -33.419, lng: 149.577 });
  assert.throws(() => parseLatLng('nope'));
});

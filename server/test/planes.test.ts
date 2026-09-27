import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadReckon } from '../src/feeds/planes.js';

test('deadReckon: null when track or speed is missing', () => {
  assert.equal(deadReckon({ lat: -33.4, lon: 149.6, track: null, gs: 200 }, 10), null);
  assert.equal(deadReckon({ lat: -33.4, lon: 149.6, track: 90, gs: null }, 10), null);
});

test('deadReckon: due east at a known speed moves roughly the right distance', () => {
  const start = { lat: -33.419, lon: 149.577, track: 90, gs: 300 }; // knots
  const at10 = deadReckon(start, 10)!;
  // 300kt * 1.852 km/h/kt * (10/60)h ≈ 92.6 km east, negligible latitude drift near this latitude.
  const expectedKm = 300 * 1.852 * (10 / 60);
  const lngKmPerDeg = 111.32 * Math.cos((start.lat * Math.PI) / 180);
  const movedKm = (at10.lon - start.lon) * lngKmPerDeg;
  assert.ok(Math.abs(movedKm - expectedKm) < 1, `expected ~${expectedKm}km east, got ${movedKm}km`);
  assert.ok(Math.abs(at10.lat - start.lat) < 0.01, 'latitude barely moves heading due east');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadReckon } from '../src/map/planes.js';

test('deadReckon: no projection without track/speed', () => {
  assert.equal(deadReckon({ lat: 0, lon: 0, track: null, gs: 100 }, 10), null);
});

test('deadReckon: matches the known-distance case from the server test', () => {
  const at10 = deadReckon({ lat: -33.419, lon: 149.577, track: 90, gs: 300 }, 10)!;
  const expectedKm = 300 * 1.852 * (10 / 60);
  const lngKmPerDeg = 111.32 * Math.cos((-33.419 * Math.PI) / 180);
  assert.ok(Math.abs((at10.lon - 149.577) * lngKmPerDeg - expectedKm) < 1);
});

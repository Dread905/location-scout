import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadReckon } from '../src/map/planes.js';
import { projectAlongLine } from '../src/map/freightProject.js';

test('deadReckon: no projection without track/speed', () => {
  assert.equal(deadReckon({ lat: 0, lon: 0, track: null, gs: 100 }, 10), null);
});

test('deadReckon: matches the known-distance case from the server test', () => {
  const at10 = deadReckon({ lat: -33.419, lon: 149.577, track: 90, gs: 300 }, 10)!;
  const expectedKm = 300 * 1.852 * (10 / 60);
  const lngKmPerDeg = 111.32 * Math.cos((-33.419 * Math.PI) / 180);
  assert.ok(Math.abs((at10.lon - 149.577) * lngKmPerDeg - expectedKm) < 1);
});

test('projectAlongLine: a bearing-string direction (not up/down) is not projectable', () => {
  const line: [number, number][] = [[150, -33], [150, -33.1]];
  assert.equal(projectAlongLine(line, { lat: -33, lng: 150 }, '090', 60, 10), null);
});

test('projectAlongLine: "up" moves toward the line\'s end', () => {
  const line: [number, number][] = [[150, -33], [150, -33.1], [150, -33.2]];
  const dest = projectAlongLine(line, { lat: -33, lng: 150 }, 'up', 60, 30)!; // 30km, clamped at the line's end
  assert.ok(dest.lat < -33 && dest.lat >= -33.2);
  assert.ok(Math.abs(dest.lat - -33.2) < 1e-6, 'clamped at the last point');
});

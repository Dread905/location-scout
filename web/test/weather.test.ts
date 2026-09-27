import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourAt, pickRadarFrame, weatherIcon } from '../src/map/weather.js';

const idx = { host: 'https://h', radar: { past: [{ time: 1000, path: '/a' }, { time: 1600, path: '/b' }], nowcast: [{ time: 2200, path: '/n' }] } };

test('pickRadarFrame: latest frame at or before t, else null out of range', () => {
  assert.equal(pickRadarFrame(idx, 1700_000)?.path, '/b');
  assert.equal(pickRadarFrame(idx, 2300_000)?.nowcast, true);
  assert.equal(pickRadarFrame(idx, 900_000)?.path, '/a');
  assert.equal(pickRadarFrame(idx, 3000_000), null);
  assert.equal(pickRadarFrame(idx, 0), null);
});

test('hourAt / weatherIcon', () => {
  const h = { time: '2026-09-27T03:00:00.000Z', tempC: 1, cloudPct: 0, cloudLowPct: 0, cloudMidPct: 0, cloudHighPct: 0, precipMm: 0, precipProbPct: 0, windKmh: 0, gustKmh: 0, visibilityM: 500, weatherCode: 0, fogLikely: true };
  const f = { lat: 0, lng: 0, fetchedAt: '', hourly: [h] };
  assert.equal(hourAt(f, Date.parse('2026-09-27T03:40:00Z')), h);
  assert.equal(hourAt(f, Date.parse('2026-09-28T03:40:00Z')), null);
  assert.equal(weatherIcon(h), '🌫');
  assert.equal(weatherIcon({ ...h, fogLikely: false, weatherCode: 63 }), '🌧');
});

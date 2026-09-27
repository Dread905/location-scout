import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFogLikely, parseOpenMeteo } from '../src/feeds/weather.js';

test('isFogLikely: fog codes or low visibility', () => {
  assert.equal(isFogLikely({ visibilityM: 20000, weatherCode: 45 }), true);
  assert.equal(isFogLikely({ visibilityM: null, weatherCode: 48 }), true);
  assert.equal(isFogLikely({ visibilityM: 800, weatherCode: 3 }), true);
  assert.equal(isFogLikely({ visibilityM: 24000, weatherCode: 0 }), false);
  assert.equal(isFogLikely({ visibilityM: null, weatherCode: null }), false);
});

test('parseOpenMeteo: maps unixtime hourly arrays to the contract', () => {
  const f = parseOpenMeteo({ hourly: {
    time: [1790517600, 1790521200],
    temperature_2m: [12.5, 11], cloud_cover: [80, 100], cloud_cover_low: [60, 100], cloud_cover_mid: [10, 0], cloud_cover_high: [5, 0],
    precipitation: [0, 0.2], precipitation_probability: [10, 40], wind_speed_10m: [5, 3], wind_gusts_10m: [12, 8],
    visibility: [15000, 400], weather_code: [3, null],
  } }, -33.4, 149.6, new Date('2026-09-27T00:00:00Z'));
  assert.equal(f.lat, -33.4);
  assert.equal(f.fetchedAt, '2026-09-27T00:00:00.000Z');
  assert.equal(f.hourly.length, 2);
  assert.deepEqual(f.hourly[0], {
    time: new Date(1790517600 * 1000).toISOString(), tempC: 12.5, cloudPct: 80, cloudLowPct: 60, cloudMidPct: 10, cloudHighPct: 5,
    precipMm: 0, precipProbPct: 10, windKmh: 5, gustKmh: 12, visibilityM: 15000, weatherCode: 3, fogLikely: false,
  });
  assert.equal(f.hourly[1].weatherCode, null);
  assert.equal(f.hourly[1].fogLikely, true);
});

test('parseOpenMeteo: ISO GMT strings without offset are UTC; missing data is empty', () => {
  const f = parseOpenMeteo({ hourly: { time: ['2026-09-27T03:00'] } }, 0, 0);
  assert.equal(f.hourly[0].time, '2026-09-27T03:00:00.000Z');
  assert.equal(f.hourly[0].tempC, null);
  assert.deepEqual(parseOpenMeteo({}, 0, 0).hourly, []);
});

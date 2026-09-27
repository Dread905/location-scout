import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFor, parseCriteria, railDistanceKm, recommend, scoreSlots, weatherAt, type Slot, type WeatherHour } from '../src/map/recommend.js';

const T0 = new Date('2026-10-01T00:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const hour = (h: number, o: Partial<WeatherHour> = {}): WeatherHour => ({
  time: at(h * 60).toISOString(), tempC: 15, cloudPct: 10, cloudLowPct: 0, cloudMidPct: 0, cloudHighPct: 10, precipMm: 0, precipProbPct: 0,
  windKmh: 5, gustKmh: 8, visibilityM: 20000, weatherCode: 0, fogLikely: false, ...o,
});

test('weatherAt interpolates between hours and is null outside the forecast', () => {
  const w = [hour(0, { cloudPct: 0 }), hour(1, { cloudPct: 100 })];
  assert.equal(weatherAt(w, at(30))!.cloudPct, 50);
  assert.equal(weatherAt(w, at(0))!.cloudPct, 0);
  assert.equal(weatherAt(w, at(120)), null);
  assert.equal(weatherAt(w, at(-10)), null);
});

test('scoreSlots: golden + sun on spot scores 1 with reasons; shaded day slot misses', () => {
  const slots: Slot[] = [{ t: at(0), phase: 'golden_pm', light: 'sun' }, { t: at(10), phase: 'day', light: 'shade' }];
  const [a, b] = scoreSlots({ slots, criteria: ['golden', 'sun'], now: at(-60) });
  assert.equal(a.score, 1);
  assert.deepEqual(a.reasons, ['Golden hour', 'sun on spot']);
  assert.equal(b.score, 0);
  assert.ok(b.misses.includes('spot in shade'));
});

test('scoreSlots: dramatic cloud peaks in the 30–70% band; train within window adds a reason', () => {
  const w = [hour(0, { cloudHighPct: 40 }), hour(1, { cloudHighPct: 95, cloudMidPct: 95 })];
  const slots: Slot[] = [{ t: at(0), phase: 'day', light: 'sun' }, { t: at(60), phase: 'day', light: 'sun' }];
  const s = scoreSlots({ slots, criteria: ['drama', 'train'], weather: w, passes: [{ at: at(5), label: 'XPT' }], now: at(-60), fmt: () => '17:42' });
  assert.equal(s[0].score, 1);
  assert.deepEqual(s[0].reasons, ['40% high cloud', 'XPT passes 17:42']);
  assert.ok(s[1].score < 0.2);
});

test('scoreSlots: planes are a bonus only near now', () => {
  const slots: Slot[] = [{ t: at(0), phase: 'day', light: 'sun' }, { t: at(600), phase: 'day', light: 'sun' }];
  const [now, later] = scoreSlots({ slots, criteria: ['planes'], now: at(0), livePlanes: 2 });
  assert.equal(now.score, 1);
  assert.equal(later.score, 0.5);
});

test('recommend: skips the past, spaces picks apart and merges equal neighbours into a window', () => {
  const slots: Slot[] = [];
  for (let m = 0; m < 24 * 60; m += 10) slots.push({ t: at(m), phase: (m >= 360 && m < 400) || (m >= 1080 && m < 1120) ? 'golden_am' : 'day', light: 'sun' });
  const recs = recommend({ slots, criteria: ['golden'], now: at(0), n: 5 });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].t.getTime(), at(360).getTime());
  assert.equal(recs[0].end.getTime(), at(400).getTime());
  assert.equal(recs[0].confidence, 'high');
  assert.equal(recommend({ slots, criteria: ['golden'], now: at(700) }).length, 1);
});

test('confidenceFor degrades with days out', () => {
  assert.equal(confidenceFor(at(60), at(0), true, true).confidence, 'high');
  assert.equal(confidenceFor(at(3 * 1440), at(0), true, true).confidence, 'medium');
  assert.equal(confidenceFor(at(6 * 1440), at(0), true, true).confidence, 'low');
  assert.equal(confidenceFor(at(6 * 1440), at(0), false, false).confidence, 'high');
});

test('railDistanceKm measures to the segment, not just vertices', () => {
  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[151.0, -33.0], [151.02, -33.0]] } }] };
  const d = railDistanceKm(fc, -33.001, 151.01);
  assert.ok(d > 0.09 && d < 0.13, String(d));
  assert.equal(railDistanceKm(null, 0, 0), Infinity);
});

test('parseCriteria drops unknown keys', () => {
  assert.deepEqual(parseCriteria('golden,bogus,train'), ['golden', 'train']);
  assert.equal(parseCriteria(null), null);
});

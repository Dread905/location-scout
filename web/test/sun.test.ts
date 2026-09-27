import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignments, goodNow, phaseAt, SpotLike } from '../src/map/sun.js';

const BATHURST = { lat: -33.419, lng: 149.577 };
const MIN = 60_000;

/** First minute in [from, from + hours) where the phase goes from `before` to `after`. */
function transition(fromIso: string, hours: number, before: string, after: string): Date {
  let prev = phaseAt(new Date(fromIso), BATHURST.lat, BATHURST.lng);
  for (let t = Date.parse(fromIso) + MIN; t < Date.parse(fromIso) + hours * 3_600_000; t += MIN) {
    const p = phaseAt(new Date(t), BATHURST.lat, BATHURST.lng);
    if (prev === before && p === after) return new Date(t);
    prev = p;
  }
  throw new Error(`no ${before} -> ${after} transition`);
}

function near(actual: Date, expectedIso: string, minutes = 3) {
  const diff = Math.abs(actual.getTime() - Date.parse(expectedIso)) / MIN;
  assert.ok(diff <= minutes, `${actual.toISOString()} is ${diff.toFixed(1)} min from ${expectedIso}`);
}

// Published: sunrisesunset.com (June, AEST UTC+10) and sunrisewhen.com (December, AEDT UTC+11).
test('phaseAt: Bathurst winter solstice 2026, sunrise 07:05 and sunset 17:01 AEST', () => {
  near(transition('2026-06-20T20:00:00Z', 3, 'golden_am', 'sunrise'), '2026-06-20T21:05:00Z');
  near(transition('2026-06-21T05:00:00Z', 4, 'sunset', 'golden_pm'), '2026-06-21T07:01:00Z');
});

test('phaseAt: Bathurst summer solstice 2026, sunrise 05:48 and sunset 20:10 AEDT', () => {
  near(transition('2026-12-20T17:30:00Z', 3, 'golden_am', 'sunrise'), '2026-12-20T18:48:00Z');
  near(transition('2026-12-21T07:30:00Z', 4, 'sunset', 'golden_pm'), '2026-12-21T09:10:00Z');
});

test('phaseAt: the morning runs astro, night, blue, golden_am, sunrise, golden_am, day', () => {
  const seen: string[] = [];
  for (let t = Date.parse('2026-06-20T17:00:00Z'); t < Date.parse('2026-06-21T00:00:00Z'); t += MIN) {
    const p = phaseAt(new Date(t), BATHURST.lat, BATHURST.lng);
    if (seen.at(-1) !== p) seen.push(p);
  }
  assert.deepEqual(seen, ['astro', 'night', 'blue', 'golden_am', 'sunrise', 'golden_am', 'day']);
  assert.equal(phaseAt(new Date('2026-06-21T02:00:00Z'), BATHURST.lat, BATHURST.lng), 'day'); // noon
  assert.equal(phaseAt(new Date('2026-06-21T14:00:00Z'), BATHURST.lat, BATHURST.lng), 'astro'); // midnight
});

const spot = (goodTimes: Partial<SpotLike['goodTimes']>, facingDeg: number | null = null): SpotLike => ({
  id: `t${Math.random()}`, ...BATHURST, facingDeg, goodTimes: { phases: [], months: [], days: 'any', ...goodTimes },
});

test('goodNow: matches phase, parent phase, month and day type', () => {
  const noonWed = new Date('2026-06-17T02:00:00Z'); // Wed 12:00 AEST
  const sunsetWed = new Date('2026-06-17T07:00:00Z'); // ~17:00, sun on the horizon
  assert.equal(goodNow(spot({ phases: ['day'] }), noonWed), true);
  assert.equal(goodNow(spot({ phases: ['golden_pm'] }), noonWed), false);
  assert.equal(goodNow(spot({ phases: [] }), noonWed), false, 'no phases never counts');
  assert.equal(goodNow(spot({ phases: ['golden_pm'] }), sunsetWed), true, 'sunset counts as golden_pm');
  assert.equal(goodNow(spot({ phases: ['sunset'] }), sunsetWed), true);
  assert.equal(goodNow(spot({ phases: ['day'], months: [6] }), noonWed), true);
  assert.equal(goodNow(spot({ phases: ['day'], months: [12, 1] }), noonWed), false);
  assert.equal(goodNow(spot({ phases: ['day'], days: 'weekend' }), noonWed), false);
  assert.equal(goodNow(spot({ phases: ['day'], days: 'weekday' }), noonWed), true);
});

test('alignments: a west-facing spot gets sunset alignments near the equinox', () => {
  const found = alignments(spot({}, 270), new Date('2026-03-18T00:00:00Z'), 5, 3).filter((a) => a.body === 'sun');
  assert.ok(found.length > 0, 'expected a sun alignment');
  for (const a of found) {
    assert.ok(Math.abs(a.azimuth - 270) <= 10);
    const hourAest = (a.start.getUTCHours() + 10) % 24;
    assert.ok(hourAest >= 17 && hourAest <= 19, `sunset-ish, got ${hourAest}h`);
  }
});

test('alignments: a north-facing spot gets no sunset alignment', () => {
  const found = alignments(spot({}, 0), new Date('2026-03-18T00:00:00Z'), 10, 10).filter((a) => a.body === 'sun');
  assert.equal(found.length, 0);
});

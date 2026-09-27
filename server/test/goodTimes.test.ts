import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoodTimes, GoodTimesError } from '../src/goodTimes.js';

test('parseGoodTimes: fills in defaults for an empty payload', () => {
  assert.deepEqual(parseGoodTimes(undefined), {
    phases: [], months: [], days: 'any', conditions: [], eventKeywords: [], avoid: '', notes: '',
  });
  assert.deepEqual(parseGoodTimes(null), parseGoodTimes(undefined));
});

test('parseGoodTimes: accepts a fully populated payload', () => {
  const result = parseGoodTimes({
    phases: ['golden_pm', 'sunset'],
    months: [12, 1, 2],
    days: 'weekend',
    conditions: ['clear', 'after rain'],
    eventKeywords: ['Bathurst 1000'],
    avoid: 'closed race weekends',
    notes: 'best from the top of the hill',
  });
  assert.deepEqual(result.phases, ['golden_pm', 'sunset']);
  assert.deepEqual(result.months, [1, 2, 12]); // sorted
  assert.equal(result.days, 'weekend');
  assert.deepEqual(result.conditions, ['clear', 'after rain']);
  assert.deepEqual(result.eventKeywords, ['Bathurst 1000']);
  assert.equal(result.avoid, 'closed race weekends');
});

test('parseGoodTimes: rejects an unknown phase', () => {
  assert.throws(() => parseGoodTimes({ phases: ['midnight'] }), GoodTimesError);
});

test('parseGoodTimes: rejects an out-of-range month', () => {
  assert.throws(() => parseGoodTimes({ months: [0] }), GoodTimesError);
  assert.throws(() => parseGoodTimes({ months: [13] }), GoodTimesError);
});

test('parseGoodTimes: rejects an invalid days value', () => {
  assert.throws(() => parseGoodTimes({ days: 'every day' }), GoodTimesError);
});

test('parseGoodTimes: de-duplicates months', () => {
  assert.deepEqual(parseGoodTimes({ months: [6, 6, 7] }).months, [6, 7]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFeedData, isServiceActiveOn, nextPasses, parseGtfsTime, predictTrainPositions, TrainsFeedData,
} from '../src/feeds/trains.js';

test('parseGtfsTime: handles times past midnight (>24:00:00)', () => {
  assert.equal(parseGtfsTime('00:00:00'), 0);
  assert.equal(parseGtfsTime('09:05:30'), 9 * 3600 + 5 * 60 + 30);
  assert.equal(parseGtfsTime('25:30:00'), 25 * 3600 + 30 * 60); // a service still running the next calendar day
});

const cal = { serviceId: 'weekday', days: [true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean], startDate: '20260101', endDate: '20261231' };

test('isServiceActiveOn: weekday calendar, date range, and weekday mapping', () => {
  // 2026-01-05 is a Monday.
  assert.equal(isServiceActiveOn(cal, '20260105', new Date('2026-01-05T00:00:00').getDay()), true);
  // 2026-01-10 is a Saturday.
  assert.equal(isServiceActiveOn(cal, '20260110', new Date('2026-01-10T00:00:00').getDay()), false);
  assert.equal(isServiceActiveOn(cal, '20250105', new Date('2025-01-05T00:00:00').getDay()), false, 'before the service period');
});

/**
 * A tiny fixture: a straight shape from A (dist 0) to B (dist ~11.1km),
 * departing A at 09:00:00 and arriving B at 09:10:00 — a steady 66.7km/h run.
 */
function fixture(): TrainsFeedData {
  const feed = emptyFeedData();
  feed.routes.set('R1', { id: 'R1', shortName: 'BB', longName: 'Bathurst Bullet' });
  feed.trips.push({ id: 'T1', routeId: 'R1', serviceId: 'weekday', shapeId: 'S1', headsign: 'Bathurst' });
  feed.stopsById.set('A', { id: 'A', name: 'Stop A', lat: -33.0, lng: 150.0 });
  feed.stopsById.set('B', { id: 'B', name: 'Stop B', lat: -33.1, lng: 150.0 });
  feed.stopTimesByTrip.set('T1', [
    { stopId: 'A', seq: 1, arrivalSec: parseGtfsTime('09:00:00'), departureSec: parseGtfsTime('09:00:00') },
    { stopId: 'B', seq: 2, arrivalSec: parseGtfsTime('09:10:00'), departureSec: parseGtfsTime('09:10:00') },
  ]);
  feed.shapesById.set('S1', [{ lat: -33.0, lng: 150.0 }, { lat: -33.05, lng: 150.0 }, { lat: -33.1, lng: 150.0 }]);
  feed.calendarByService.set('weekday', cal);
  return feed;
}

test('predictTrainPositions: halfway through the run, on a day the service runs', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T09:05:00'); // Monday, halfway between 09:00 and 09:10
  const [pos] = predictTrainPositions(feed, at, []);
  assert.ok(pos, 'a position was predicted');
  assert.equal(pos.status, 'scheduled');
  assert.ok(Math.abs(pos.lat - -33.05) < 0.005, `expected ~halfway (-33.05), got ${pos.lat}`);
});

test('predictTrainPositions: a realtime vehicle position wins over the interpolated one, and is marked live', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T09:05:00');
  const [pos] = predictTrainPositions(feed, at, [{ tripId: 'T1', delaySec: 0, vehicleLat: -33.02, vehicleLng: 150.0 }]);
  assert.equal(pos.status, 'live');
  assert.equal(pos.lat, -33.02);
});

test('predictTrainPositions: nothing running outside the trip\'s window, or on a day off', () => {
  const feed = fixture();
  assert.equal(predictTrainPositions(feed, new Date('2026-01-05T08:00:00'), []).length, 0, 'before the trip starts');
  assert.equal(predictTrainPositions(feed, new Date('2026-01-10T09:05:00'), []).length, 0, 'Saturday: service off');
});

test('nextPasses: finds the scheduled time nearest a spot on the line, within the window', () => {
  const feed = fixture();
  const spot = { lat: -33.05, lng: 150.0 }; // right at the shape's midpoint
  const now = new Date('2026-01-05T06:00:00'); // Monday morning, before the 09:00 departure
  const passes = nextPasses(feed, spot, 6, now);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].tripId, 'T1');
  const hhmm = `${String(passes[0].at.getHours()).padStart(2, '0')}:${String(passes[0].at.getMinutes()).padStart(2, '0')}`;
  assert.equal(hhmm, '09:05', 'local time, timezone-independent: midpoint in distance ≈ midpoint in time here');
});

test('nextPasses: a spot far from the line gets nothing', () => {
  const feed = fixture();
  const passes = nextPasses(feed, { lat: -33.05, lng: 152.0 }, 24, new Date('2026-01-05T06:00:00'));
  assert.equal(passes.length, 0);
});

test('predictTrainPositions: a realtime vehicle with no running scheduled trip is still shown, as live', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T08:00:00'); // before T1's window
  const out = predictTrainPositions(feed, at, [
    { tripId: 'T1', delaySec: 120, vehicleLat: -33.01, vehicleLng: 150.0 },
    { tripId: 'UNKNOWN', delaySec: 0, vehicleLat: -33.5, vehicleLng: 150.5 },
    { tripId: 'NOPOS', delaySec: 0 },
  ]);
  assert.equal(out.length, 2, 'the entry without a position is dropped');
  const t1 = out.find((p) => p.tripId === 'T1')!;
  assert.equal(t1.status, 'live');
  assert.equal(t1.route, 'BB', 'route and headsign come from the static trip when known');
  assert.equal(t1.headsign, 'Bathurst');
  assert.equal(t1.delaySec, 120);
  assert.equal(out.find((p) => p.tripId === 'UNKNOWN')!.status, 'live');
});

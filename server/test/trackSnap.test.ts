import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackGraph, snapToTrack } from '../src/feeds/trackSnap.js';
import { bearingDeg, cumulativeKm, emptyFeedData, parseGtfsTime, predictTrainPositions } from '../src/feeds/trains.js';
import { resetTrackGraphCache, trackGraphFor } from '../src/sources/rail.js';
import { createDb } from '../src/db.js';

type P = [number, number];
const K = Math.cos((-33.89 * Math.PI) / 180);
/** Local metres (x east, y north) around Eveleigh -> [lng, lat]. */
const m = (x: number, y: number): P => [151.19 + x / (111_320 * K), -33.89 + y / 111_320];
const toM = (p: P): P => [(p[0] - 151.19) * 111_320 * K, (p[1] + 33.89) * 111_320];

/** Distance (m) from a point to a polyline in local metres. */
function offM(line: P[], p: P): number {
  const q = toM(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [toM(line[i - 1]), toM(line[i])];
    const [bx, by] = [b[0] - a[0], b[1] - a[1]];
    const L2 = bx * bx + by * by;
    const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * bx + (q[1] - a[1]) * by) / L2)) : 0;
    best = Math.min(best, Math.hypot(q[0] - a[0] - t * bx, q[1] - a[1] - t * by));
  }
  return best;
}

/**
 * Two parallel tracks 4 m apart running SW->NE then bending east (like the Eveleigh corridor), split into several OSM
 * ways that meet at shared nodes, plus a turnout leaving the up track northwards at x=0.
 */
function corridor() {
  const arc = (dy: number): P[] => {
    const pts: P[] = [];
    for (let x = -600; x <= 0; x += 50) pts.push(m(x, x * 0.6 + dy)); // straight, heading ~59 deg
    for (let a = 0; a <= 30; a += 3) {                                  // curving round to due east, radius 600 m
      const t = ((59 + a) * Math.PI) / 180;
      const last = pts.at(-1)!; const [lx, ly] = toM(last);
      pts.push(m(lx + 30 * Math.sin(t), ly + 30 * Math.cos(t)));
    }
    const [ex, ey] = toM(pts.at(-1)!);
    for (let x = 50; x <= 600; x += 50) pts.push(m(ex + x, ey));
    return pts;
  };
  const up = arc(0);
  const down = arc(4);
  // Split each track into 3 ways sharing their end nodes, as OSM does.
  const split = (l: P[]) => [l.slice(0, 8), l.slice(7, 20), l.slice(19)];
  const turnout: P[] = [up[12], m(toM(up[12])[0] + 10, toM(up[12])[1] + 60), m(toM(up[12])[0] + 12, toM(up[12])[1] + 400)];
  return { up, down, lines: [...split(up), ...split(down), turnout].map((coords) => ({ coords })) };
}

test('snapToTrack: snaps to the nearest of two parallel tracks and walks back round the curve along that track', () => {
  const { up, down, lines } = corridor();
  const g = buildTrackGraph(lines);
  // Lead 1 m from the down track (3 m from the up), just past the curve, heading east-ish.
  const [hx, hy] = toM(down[18]);
  const snap = snapToTrack(g, m(hx, hy - 1), { bearing: 80, backKm: 0.6, aheadKm: 0.3 })!;
  assert.ok(snap, 'snapped');
  for (const p of snap.path) assert.ok(offM(down, p) < 0.01, `path point ${offM(down, p)} m off the down track`);
  const cum = cumulativeKm(snap.path);
  assert.ok(Math.abs(snap.atKm - 0.6) < 0.01, `lead ${snap.atKm} km along`);
  assert.ok(Math.abs(cum.at(-1)! - 0.9) < 0.01);
  // It bends: the first stretch heads ~59 deg, the last due east.
  assert.ok(Math.abs(bearingDeg(snap.path[0], snap.path[1]) - 59) < 3);
  assert.ok(Math.abs(bearingDeg(snap.path.at(-2)!, snap.path.at(-1)!) - 90) < 3);
  // The neighbouring train on the up track stays on the up track.
  const other = snapToTrack(g, m(hx, hy - 3.5), { bearing: 80, backKm: 0.6, aheadKm: 0.3 })!;
  for (const p of other.path) assert.ok(offM(up, p) < 0.01);
});

test('snapToTrack: direction from the bearing; nothing within 60 m -> null', () => {
  const { up, lines } = corridor();
  const g = buildTrackGraph(lines);
  const westbound = snapToTrack(g, up[25], { bearing: 270, backKm: 0.2, aheadKm: 0.2 })!;
  assert.ok(toM(westbound.path[0])[0] > toM(westbound.path.at(-1)!)[0], 'path runs westwards');
  assert.equal(snapToTrack(g, m(0, -300), { bearing: 90, backKm: 0.2, aheadKm: 0.2 }), null);
  assert.equal(snapToTrack(g, up[3], { backKm: 0.2, aheadKm: 0.2 }), null, 'no bearing or shape: direction unknown');
});

test('snapToTrack: at a turnout, follows the branch the GTFS shape takes (coarse, 20 m off), else the straightest', () => {
  const { up, lines } = corridor();
  const g = buildTrackGraph(lines);
  const j = toM(up[12]);
  // Coarse shape (4 points) roughly following the turnout northwards, ~20 m to the side.
  const shape: P[] = [m(j[0] - 300, j[1] - 180), m(j[0] - 20, j[1] + 5), m(j[0] + 30, j[1] + 150), m(j[0] + 35, j[1] + 400)];
  const lead = m(j[0] - 40, j[1] - 24); // on the up track, before the junction, heading NE
  const withShape = snapToTrack(g, lead, { shape, backKm: 0.1, aheadKm: 0.3 })!;
  assert.ok(toM(withShape.path.at(-1)!)[1] > j[1] + 150, 'took the northbound turnout');
  const straight = snapToTrack(g, lead, { bearing: 59, backKm: 0.1, aheadKm: 0.3 })!;
  assert.ok(offM(up, straight.path.at(-1)!) < 0.01, 'without a shape, kept to the main line');
});

test('predictTrainPositions: the root cause — a realtime-only Sydney Trains vehicle had no path (rigid chain on its bearing); with rails it gets one on the track', () => {
  const { down, lines } = corridor();
  const feed = emptyFeedData();
  const [hx, hy] = toM(down[18]);
  const rt = [{ tripId: 'RT-ONLY', delaySec: 0, vehicleLat: m(hx, hy + 7)[1], vehicleLng: m(hx, hy + 7)[0], bearing: 85, feed: 'sydneytrains' as const }];
  const [before] = predictTrainPositions(feed, new Date('2026-01-05T09:05:00'), rt);
  assert.equal(before.path, undefined);
  const [after] = predictTrainPositions(feed, new Date('2026-01-05T09:05:00'), rt, buildTrackGraph(lines));
  assert.ok(after.path && after.pathAtKm != null);
  assert.ok(offM(down, [after.lng, after.lat]) < 0.01, 'lead moved onto the track');
  for (const p of after.path!) assert.ok(offM(down, p) < 0.2); // metres; paths are rounded to ~0.1 m
});

test('predictTrainPositions: a scheduled train on a coarse, offset GTFS shape is snapped onto the rails', () => {
  const { up, down, lines } = corridor();
  const feed = emptyFeedData();
  // A 3-point shape 25 m north-west of the up track, cutting the curve's corner.
  const shape = [m(-600, -360 + 25), m(0, 25), m(600, 170 + 25)].map(([lng, lat]) => ({ lat, lng }));
  feed.routes.set('T2', { id: 'T2', shortName: 'T2', longName: 'Inner West' });
  feed.trips.push({ id: 'X', routeId: 'T2', serviceId: 'wk', shapeId: 'S', headsign: 'City' });
  feed.shapesById.set('S', shape);
  feed.stopsById.set('A', { id: 'A', name: 'A', ...shape[0] });
  feed.stopsById.set('B', { id: 'B', name: 'B', ...shape[2] });
  feed.stopTimesByTrip.set('X', [
    { stopId: 'A', seq: 1, arrivalSec: parseGtfsTime('09:00:00'), departureSec: parseGtfsTime('09:00:00') },
    { stopId: 'B', seq: 2, arrivalSec: parseGtfsTime('09:02:00'), departureSec: parseGtfsTime('09:02:00') },
  ]);
  feed.calendarByService.set('wk', { serviceId: 'wk', days: [true, true, true, true, true, true, true], startDate: '20260101', endDate: '20261231' });
  const [pos] = predictTrainPositions(feed, new Date('2026-01-05T09:00:50'), [], buildTrackGraph(lines));
  // Which of the pair it lands on depends on the shape's error; either way it's on a track and stays on that one.
  const track = offM(up, [pos.lng, pos.lat]) < offM(down, [pos.lng, pos.lat]) ? up : down;
  assert.ok(offM(track, [pos.lng, pos.lat]) < 0.01, `lead ${offM(track, [pos.lng, pos.lat])} m off the track`);
  for (const p of pos.path!) assert.ok(offM(track, p) < 0.2);
  assert.ok(pos.bearing! > 30 && pos.bearing! < 100, 'heading city-wards (east-ish)');
});

test('trackGraphFor: fetches a rail tile around a train the cached network misses, then uses it (Rail overlay irrelevant)', async () => {
  resetTrackGraphCache();
  const db = createDb(':memory:');
  const { lines } = corridor();
  let calls = 0;
  const fetchTile = async () => { calls++; return lines; };
  const train = { lat: -33.89, lng: 151.19 };
  const g1 = trackGraphFor(db, [train], fetchTile);
  assert.equal(g1.pts.length, 0);
  assert.equal(calls, 1);
  trackGraphFor(db, [train], fetchTile); // in flight or done: not fetched twice
  await new Promise((r) => setTimeout(r, 0));
  const g2 = trackGraphFor(db, [train], fetchTile);
  assert.ok(g2.pts.length > 0);
  assert.equal(calls, 1);
  resetTrackGraphCache();
});

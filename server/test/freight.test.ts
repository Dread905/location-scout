import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePassPattern, passHistogram, projectAlongLine, projectOntoLine, snapToNearestLine } from '../src/feeds/freight.js';

// A straight north-south line, ~11.1km per 0.1deg of latitude — long enough for a 30km "up" test below.
const straightLine: [number, number][] = [[150.0, -33.0], [150.0, -33.1], [150.0, -33.2], [150.0, -33.3], [150.0, -33.4]];

test('projectOntoLine: a known distance along a straight line', () => {
  const p = projectOntoLine(straightLine, { lat: -33.05, lng: 150.0 })!;
  assert.ok(p, 'projects onto the line');
  // -33.0 to -33.05 is half of the first 11.1km segment.
  assert.ok(Math.abs(p.atKm - 5.55) < 0.2, `expected ~5.55km, got ${p.atKm}`);
  assert.ok(p.offKm < 0.01, 'point is on the line');
});

test('projectAlongLine: moving "up" (toward increasing index) covers the expected distance', () => {
  const start = { lat: -33.0, lng: 150.0 };
  const speedKmh = 60;
  const minutes = 30; // 30km
  const dest = projectAlongLine(straightLine, start, 'up', speedKmh, minutes)!;
  const startProj = projectOntoLine(straightLine, start)!;
  const destProj = projectOntoLine(straightLine, dest)!;
  assert.ok(Math.abs(destProj.atKm - startProj.atKm - 30) < 0.5, `expected +30km along the line, got ${destProj.atKm - startProj.atKm}`);
});

test('projectAlongLine: "down" moves the other way and clamps at the start of the line', () => {
  const start = { lat: -33.05, lng: 150.0 };
  const dest = projectAlongLine(straightLine, start, 'down', 200, 60)!; // would overshoot the line's start
  const destProj = projectOntoLine(straightLine, dest)!;
  assert.ok(destProj.atKm < 0.01, 'clamped at the start of the line');
});

test('snapToNearestLine: picks the closer of two lines, and refuses anything too far off', () => {
  const other: [number, number][] = [[151.0, -33.0], [151.0, -33.2]];
  const lines = [{ ref: 'near', coords: straightLine }, { ref: 'far', coords: other }];
  const hit = snapToNearestLine(lines, { lat: -33.05, lng: 150.001 });
  assert.equal(hit?.lineRef, 'near');
  const miss = snapToNearestLine(lines, { lat: -33.05, lng: 152.0 }, 0.3);
  assert.equal(miss, null);
});

test('passHistogram + describePassPattern: needs at least 3 sightings within 2km before it speaks up', () => {
  const spot = { lat: -33.42, lng: 149.58 };
  const near = (offsetM: number) => spot.lat + offsetM / 111_320;
  const sightings = [
    { lat: near(50), lng: spot.lng, seenAt: '2026-01-06T09:15:00Z' }, // Tuesday
    { lat: near(50), lng: spot.lng, seenAt: '2026-01-08T10:05:00Z' }, // Thursday
    { lat: near(50), lng: spot.lng, seenAt: '2026-01-10T09:45:00Z' }, // Saturday
    { lat: 0, lng: 0, seenAt: '2026-01-10T09:45:00Z' }, // way outside the 2km radius
  ];
  const histogram = passHistogram(sightings, spot);
  assert.equal(histogram.reduce((s, e) => s + e.count, 0), 3, 'the far-away sighting is excluded');
  const pattern = describePassPattern(histogram);
  assert.match(pattern!, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(–(Sun|Mon|Tue|Wed|Thu|Fri|Sat))? \d{2}–\d{2}$/);

  assert.equal(describePassPattern(histogram.slice(0, 1)), null, 'not enough history yet');
});

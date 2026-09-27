import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_MS, cumulative, distKm, due, MAX_TRAIN_EXTRAP_MS, MotionTracker, planePredict, pointAlong, trainPredict } from '../src/map/motion.js';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('planePredict: dead-reckons along track at ground speed, counting the report age; still without track', () => {
  const p = { lat: -33, lon: 151, track: 90, gs: 360, seen: 0 }; // 360 kt = 666.72 km/h = 185.2 m/s
  const at = planePredict(p)(10_000);
  near(at.lat, -33, 1e-4);
  near(distKm([151, -33], [at.lng, at.lat]), 1.852, 0.005);
  assert.equal(at.bearing, 90);
  const aged = planePredict({ ...p, seen: 5 })(5_000);
  near(aged.lng, at.lng, 1e-9);
  const still = planePredict({ ...p, track: null })(10_000);
  assert.deepEqual([still.lng, still.lat], [151, -33]);
});

test('pointAlong: interpolates, gives the segment bearing, extrapolates past the ends', () => {
  const path: [number, number][] = [[150, -33], [150, -33.01], [150.01, -33.01]];
  const cum = cumulative(path);
  near(cum[1], 1.1132, 1e-3);
  const mid = pointAlong(path, cum[1] / 2, cum);
  near(mid.lat, -33.005, 1e-9);
  near(mid.bearing, 180, 1e-9);
  const corner = pointAlong(path, cum[1] + 0.1, cum);
  near(corner.bearing, 90, 1e-6);
  const before = pointAlong(path, -1.1132, cum);
  near(before.lat, -32.99, 1e-4);
  const after = pointAlong(path, cum[2] + 0.5, cum);
  assert.ok(after.lng > 150.01);
});

test('trainPredict: runs along the path at its speed, capped, and stops at the path end', () => {
  const path: [number, number][] = [[150, -33], [150, -33.1]]; // ~11.13 km south
  const t = { lat: -33.01, lng: 150, speedMps: 20, path, pathAtKm: 1.1132 };
  const p = trainPredict(t);
  near(p(0).lat, -33.01, 1e-9);
  near(p(10_000).pathKm!, 1.1132 + 0.2, 1e-9);
  near(p(10 * MAX_TRAIN_EXTRAP_MS).pathKm!, 1.1132 + (20 * MAX_TRAIN_EXTRAP_MS) / 1e6, 1e-9);
  near(trainPredict({ ...t, speedMps: 1000 })(40_000).pathKm!, cumulative(path)[1], 1e-9);
  // No path: stays where reported.
  const flat = trainPredict({ lat: -33, lng: 150, bearing: 45, speedMps: 20 })(10_000);
  assert.deepEqual([flat.lng, flat.lat, flat.bearing], [150, -33, 45]);
});

test('trainPredict: a train with a path is drawn on it (no sideways offset carried along)', () => {
  const path: [number, number][] = [[150, -33], [150, -33.1]];
  const p = trainPredict({ lat: -33.01, lng: 150.001, speedMps: 10, path, pathAtKm: 1.1132 });
  near(p(0).lng, 150, 1e-9);
  near(p(20_000).lng, 150, 1e-9);
  assert.equal(p(0).path, path);
});

test('MotionTracker: a train re-reported further along its track glides along the curve, not across it', () => {
  // A quarter-ish bend: east ~90 m then south ~110 m. Old report at the start, new one round the corner.
  const path: [number, number][] = [[151.19, -33.89], [151.191, -33.89], [151.191, -33.891]];
  const cum = cumulative(path);
  const mt = new MotionTracker();
  mt.update([{ id: 't', predict: trainPredict({ lat: -33.89, lng: 151.19, speedMps: 0, path, pathAtKm: 0.01 }), key: 'a' }], 0);
  mt.update([{ id: 't', predict: trainPredict({ lat: -33.8905, lng: 151.191, speedMps: 0, path, pathAtKm: cum[1] + 0.05 }), key: 'b' }], 1000);
  for (let t = 1000; t <= 1000 + BLEND_MS; t += 100) {
    const p = mt.pose('t', t)!;
    // Every blended pose lies on the polyline: either on the east leg (lat -33.89) or the south leg (lng 151.191).
    const onEast = Math.abs(p.lat - -33.89) < 1e-9; const onSouth = Math.abs(p.lng - 151.191) < 1e-9;
    assert.ok(onEast || onSouth, `pose ${p.lng},${p.lat} is off the track`);
  }
});

test('MotionTracker: a train whose new path doesn\'t pass the drawn pose (another track) jumps rather than sliding across', () => {
  const mt = new MotionTracker();
  const a: [number, number][] = [[151, -33], [151, -33.01]];
  const b: [number, number][] = [[151.0001, -33], [151.0001, -33.01]]; // ~9 m east: the next track over
  mt.update([{ id: 't', predict: trainPredict({ lat: -33.005, lng: 151, speedMps: 0, path: a, pathAtKm: 0.5566 }), key: 'a' }], 0);
  mt.update([{ id: 't', predict: trainPredict({ lat: -33.005, lng: 151.0001, speedMps: 0, path: b, pathAtKm: 0.5566 }), key: 'b' }], 1000);
  near(mt.pose('t', 1001)!.lng, 151.0001, 1e-9);
});

test('MotionTracker: blends from the drawn pose to a new report, snaps on big jumps, keeps unchanged reports', () => {
  const mt = new MotionTracker();
  const still = (lng: number, lat: number) => () => ({ lng, lat, bearing: null });
  mt.update([{ id: 'a', predict: still(150, -33), key: 'k1' }], 0);
  assert.deepEqual(mt.pose('a', 0), { lng: 150, lat: -33, bearing: null });
  mt.update([{ id: 'a', predict: still(150.01, -33), key: 'k2' }], 1000);
  near(mt.pose('a', 1000)!.lng, 150);
  const half = mt.pose('a', 1000 + BLEND_MS / 2)!.lng;
  near(half, 150.005, 1e-9); // smoothstep(0.5) = 0.5
  near(mt.pose('a', 1000 + BLEND_MS)!.lng, 150.01);
  // Same key: the running track is kept, not restarted.
  mt.update([{ id: 'a', predict: still(0, 0), key: 'k2' }], 5000);
  near(mt.pose('a', 5000)!.lng, 150.01);
  // A jump past MAX_BLEND_KM snaps.
  mt.update([{ id: 'a', predict: still(151, -33), key: 'k3' }], 6000);
  near(mt.pose('a', 6000)!.lng, 151);
  // Dropped from the feed: gone.
  mt.update([], 7000);
  assert.equal(mt.pose('a', 7000), null);
  assert.equal(mt.has('a'), false);
});

test('due: capped frame rate', () => {
  assert.equal(due(0, 50), false);
  assert.equal(due(0, 100), true);
});

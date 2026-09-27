import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxTriangles, CAR_GAP_M, CAR_LEN_M, carriageCount, placeCarriages } from '../src/map/trains3d.js';
import { distKm } from '../src/map/motion.js';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('carriageCount: realtime consist wins, else defaults by network and service', () => {
  assert.equal(carriageCount({ carriages: 6, network: 'sydneytrains' }), 6);
  assert.equal(carriageCount({ carriages: 99 }), 16);
  assert.equal(carriageCount({ carriages: null, network: 'sydneytrains', route: 'T1' }), 8);
  assert.equal(carriageCount({ network: 'nswtrains', route: 'Central to Melbourne XPT' }), 7);
  assert.equal(carriageCount({ network: 'nswtrains', route: 'Canberra Xplorer' }), 3);
  assert.equal(carriageCount({ network: 'nswtrains', route: 'Hunter Line' }), 2);
  assert.equal(carriageCount({ network: 'nswtrains', route: 'BMT' }), 4);
  assert.equal(carriageCount({ route: 'T4' }), 8);
  assert.equal(carriageCount({ route: '' }), 4);
});

test('placeCarriages: a chain trailing back along a straight path, each car its real length, nose at the head', () => {
  const path: [number, number][] = [[150, -33], [150, -33.01]]; // heading south
  const head: [number, number] = [150, -33.005];
  const headKm = distKm(path[0], head);
  const cars = placeCarriages({ path, headKm, head, bearing: 180 }, 4);
  assert.equal(cars.length, 4);
  near(cars[0].front[1], head[1], 1e-9);
  for (const c of cars) {
    near(distKm(c.rear, c.front) * 1000, CAR_LEN_M, 0.01);
    near(c.bearing, 180, 1e-6);
  }
  near(distKm(cars[0].rear, cars[1].front) * 1000, CAR_GAP_M, 0.01);
  assert.ok(cars[3].rear[1] > cars[0].front[1], 'the tail is north (behind) of the nose');
});

test('placeCarriages: follows a bend, and trails straight back past the start of the path', () => {
  // East for ~50 m, then turning south: a train heading south round the corner has its rear cars still going east.
  const path: [number, number][] = [[150, -33], [150.0005, -33], [150.0005, -33.001]];
  const headKm = distKm(path[0], path[1]) + 0.02;
  const cars = placeCarriages({ path, headKm, head: [150.0005, -33.00018], bearing: 180 }, 4);
  near(cars[0].bearing, 180, 1);
  near(cars[2].bearing, 90, 1);
  near(cars[3].bearing, 90, 1); // beyond the path start: extrapolated along the first segment
});

test('placeCarriages: without a path, straight back from the head along the bearing; scale stretches', () => {
  const cars = placeCarriages({ head: [150, -33], bearing: 90 }, 2, 3);
  near(cars[0].front[0], 150);
  assert.ok(cars[1].rear[0] < cars[0].rear[0], 'trailing west of an east-bound head');
  near(distKm(cars[0].rear, cars[0].front) * 1000, CAR_LEN_M * 3, 0.05);
  near(cars[1].bearing, 90, 1e-6);
});

test('boxTriangles: 5 faces (no floor), width and height as asked, sitting on the ground heights', () => {
  const tris = boxTriangles([0, 0], [0, 20], 3, 4, 10, 12);
  assert.equal(tris.length, 30);
  const xs = tris.map((t) => t.p[0]);
  near(Math.max(...xs) - Math.min(...xs), 3);
  const roof = tris.filter((t) => t.shade === 1);
  assert.ok(roof.every((t) => t.p[2] === 14 || t.p[2] === 16), 'roof is h above each end');
  assert.equal(Math.min(...tris.map((t) => t.p[2])), 10);
});

test('placeCarriages: on a curve, every carriage has both bogie points on the track and its own heading', () => {
  // An arc of radius ~300 m (a typical suburban curve), densely sampled, travelling anticlockwise.
  const R = 0.3; const c: [number, number] = [151.19, -33.89];
  const k = Math.cos((c[1] * Math.PI) / 180);
  const path: [number, number][] = [];
  for (let a = 0; a <= 90; a += 1) {
    const t = (a * Math.PI) / 180;
    path.push([c[0] + (R * Math.cos(t)) / (111.32 * k), c[1] + (R * Math.sin(t)) / 111.32]);
  }
  const total = distKm(path[0], path[1]) * 90;
  const cars = placeCarriages({ path, headKm: total * 0.9, head: [0, 0], bearing: null }, 8);
  const r = (p: [number, number]) => Math.hypot((p[0] - c[0]) * 111.32 * k, (p[1] - c[1]) * 111.32);
  for (const car of cars) {
    near(r(car.front), R, 0.0005); // within 0.5 m of the arc
    near(r(car.rear), R, 0.0005);
  }
  // Headings turn steadily from car to car (not one rigid bearing for the whole train).
  const spread = Math.abs(cars[0].bearing - cars[7].bearing);
  assert.ok(spread > 25, `expected the consist to bend (~30 deg), got ${spread}`);
});

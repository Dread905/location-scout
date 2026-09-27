import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altitudeM, MAX_PLANE_SHADOW_M, pitchBlend, zoomBlend, planeLabel, planeShadowPos, renderAltitude, rotateByTrack } from '../src/map/planes3d.js';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('altitudeM: feet to metres, ground is 0, unknown is null', () => {
  near(altitudeM(10_000)!, 3048);
  assert.equal(altitudeM('ground'), 0);
  assert.equal(altitudeM(null), null);
  assert.equal(altitudeM(undefined), null);
  assert.equal(altitudeM(-200), 0);
});

test('renderAltitude: true height above ground on top of the exaggerated ground', () => {
  near(renderAltitude(3000, 0, 1.4), 3000);
  near(renderAltitude(3000, 1400, 1.4), 1400 + 2000);
  near(renderAltitude(500, 1400, 1.4), 1400); // below the (real) ground: sits on it
});

test('planeShadowPos: away from the sun, h/tan(alt), capped, none at night', () => {
  const [lng, lat] = planeShadowPos(150, 0, 1000, { azimuth: 0, altitude: 45 })!;
  near(lng, 150);
  near((0 - lat) * 110_540, 1000, 1e-3); // sun north, shadow 1 km south
  const [lng2] = planeShadowPos(0, 0, 10_000, { azimuth: 270, altitude: 10 })!;
  near(lng2 * 111_320, MAX_PLANE_SHADOW_M, 1e-3); // sun west, shadow east, capped
  assert.equal(planeShadowPos(0, 0, 1000, { azimuth: 0, altitude: -1 }), null);
});

test('planeLabel', () => {
  assert.equal(planeLabel('QFA123 ', 'abc', 9412), 'QFA123 · 9,400 m');
  assert.equal(planeLabel('', 'abc', 0), 'ABC · ground');
  assert.equal(planeLabel('X', 'abc', null), 'X');
});

test('pitchBlend: 0 flat, 1 pitched, monotonic', () => {
  assert.equal(pitchBlend(0), 0);
  assert.equal(pitchBlend(60), 1);
  assert.ok(pitchBlend(20) > 0 && pitchBlend(20) < pitchBlend(30) && pitchBlend(30) < 1);
});

test('rotateByTrack: nose points along the track', () => {
  const [x, y] = rotateByTrack(0, 1, 90);
  near(x, 1); near(y, 0);
  const [x2, y2] = rotateByTrack(0, 1, 180);
  near(x2, 0); near(y2, -1);
});

test('zoomBlend: flat below z13.5, full 3D from z14.5', () => {
  assert.equal(zoomBlend(12), 0);
  assert.equal(zoomBlend(13.5), 0);
  assert.equal(zoomBlend(14.5), 1);
  assert.equal(zoomBlend(17), 1);
  near(zoomBlend(14), 0.5);
});

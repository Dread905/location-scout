import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bboxFromRadius, inBbox, parseBbox, parseLatLng, tileArea } from '../src/geo.js';

test('haversine: one degree of longitude at the equator is ~111.32km', () => {
  const d = haversine(0, 0, 0, 1);
  assert.ok(Math.abs(d - 111320) < 200, `expected ~111320m, got ${d}`);
});

test('haversine: same point is zero', () => {
  assert.equal(haversine(-33.419, 149.577, -33.419, 149.577), 0);
});

test('bboxFromRadius: a point sits inside its own box', () => {
  const box = bboxFromRadius(-33.419, 149.577, 100);
  assert.ok(inBbox(box, -33.419, 149.577));
});

test('bboxFromRadius: a point far outside the radius sits outside the box', () => {
  const box = bboxFromRadius(-33.419, 149.577, 100); // Bathurst, 100km
  assert.equal(inBbox(box, -33.868, 151.207), false); // Sydney, ~200km away
});

test('parseBbox / parseLatLng: round-trip valid input, reject malformed input', () => {
  assert.deepEqual(parseBbox('-34,149,-33,150'), { south: -34, west: 149, north: -33, east: 150 });
  assert.throws(() => parseBbox('not,a,bbox'));
  assert.deepEqual(parseLatLng('-33.419,149.577'), { lat: -33.419, lng: 149.577 });
  assert.throws(() => parseLatLng('nope'));
});

test('tileArea: small area within maxTileKm produces a single tile', () => {
  const original = bboxFromRadius(-33.419, 149.577, 15); // diameter ~30km < 50km
  const tiles = tileArea(-33.419, 149.577, 15, 50);
  assert.equal(tiles.length, 1);
  assert.deepEqual(tiles[0], original);
});

test('tileArea: large area produces bounded tiles that cover the full bbox without gaps', () => {
  const radiusKm = 100;
  const maxTileKm = 50;
  const original = bboxFromRadius(-33.419, 149.577, radiusKm);
  const tiles = tileArea(-33.419, 149.577, radiusKm, maxTileKm);

  // 200km across / 50km = 4x4 = 16 tiles
  assert.equal(tiles.length, 16);

  // Check coverage
  const minSouth = Math.min(...tiles.map((t) => t.south));
  const maxNorth = Math.max(...tiles.map((t) => t.north));
  const minWest = Math.min(...tiles.map((t) => t.west));
  const maxEast = Math.max(...tiles.map((t) => t.east));

  assert.ok(Math.abs(minSouth - original.south) < 1e-6);
  assert.ok(Math.abs(maxNorth - original.north) < 1e-6);
  assert.ok(Math.abs(minWest - original.west) < 1e-6);
  assert.ok(Math.abs(maxEast - original.east) < 1e-6);

  // Verify each tile is bounded within maxTileKm + small margin
  for (const t of tiles) {
    const latSpanKm = (t.north - t.south) * 111.32;
    assert.ok(latSpanKm <= maxTileKm + 0.1, `latSpanKm ${latSpanKm} should be <= ${maxTileKm}`);
  }
});

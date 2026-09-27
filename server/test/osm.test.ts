import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCandidateElements } from '../src/sources/osm.js';

test('mapCandidateElements: nodes and ways (via center), deduped by ref', () => {
  const elements = [
    { type: 'node' as const, id: 1, lat: -33.42, lon: 149.58, tags: { tourism: 'viewpoint', name: 'Sunset Point' } },
    { type: 'way' as const, id: 2, center: { lat: -33.43, lon: 149.59 }, tags: { historic: 'ruins' } },
    { type: 'node' as const, id: 1, lat: -33.42, lon: 149.58, tags: { tourism: 'viewpoint', name: 'Sunset Point' } }, // duplicate
    { type: 'way' as const, id: 3, tags: { 'disused:railway': 'station' } }, // no center: dropped
  ];
  const rows = mapCandidateElements(elements as unknown as Parameters<typeof mapCandidateElements>[0]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ref, 'node/1');
  assert.equal(rows[0].name, 'Sunset Point');
  assert.equal(rows[1].ref, 'way/2');
  assert.equal(rows[1].lat, -33.43);
});

import { buildingsFromOverpass } from '../src/sources/osm.js';

test('buildingsFromOverpass: closes rings, derives height from tag or levels', () => {
  const sq = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }];
  const fc = buildingsFromOverpass([
    { type: 'way', id: 1, geometry: [...sq, sq[0]], tags: { building: 'yes', height: '12 m' } },
    { type: 'way', id: 2, geometry: sq, tags: { building: 'yes', 'building:levels': '4' } },
    { type: 'way', id: 3, geometry: [...sq, sq[0]], tags: { building: 'yes' } },
    { type: 'way', id: 4, geometry: sq.slice(0, 2) },
  ]);
  assert.equal(fc.features.length, 3);
  assert.deepEqual(fc.features.map((f) => f.properties?.height), [12, 12, undefined]);
  const ring = fc.features[1].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

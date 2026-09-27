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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRailPassPopupHtml, clickableRailLayerIds } from '../src/map/railPasses.js';
import type { TrainPass } from '../src/api.js';

const styleLayers = [
  { id: 'road_major_rail', type: 'line', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'] },
  { id: 'tunnel_transit_rail', type: 'line', 'source-layer': 'transportation', filter: ['match', ['get', 'class'], ['transit'], true, false] },
  { id: 'rail-lines', type: 'line', source: 'rail' },
  { id: 'rail-industrial', type: 'line', source: 'rail' },
  { id: 'rail-label', type: 'symbol', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'] },
] as const;

test('clickableRailLayerIds includes imported passenger rail and only visible base rail layers', () => {
  const visible = new Set(['road_major_rail', 'rail-lines', 'rail-industrial']);
  const ids = clickableRailLayerIds(styleLayers, (id) => visible.has(id));
  assert.deepEqual(ids, ['rail-lines', 'road_major_rail']);
});

test('buildRailPassPopupHtml escapes train text and shows configured/no-pass states', () => {
  const pass: TrainPass = {
    tripId: 't1',
    routeId: 'r1',
    route: '<T1>',
    headsign: 'Central & "City"',
    at: '2026-01-05T09:05:00.000Z',
  };
  const html = buildRailPassPopupHtml({ configured: true, passes: [pass] });
  assert.match(html, /&lt;T1&gt;/);
  assert.match(html, /Central &amp; &quot;City&quot;/);
  assert.doesNotMatch(html, /<T1>/);
  assert.match(html, /8:05 PM Jan 5/);

  assert.match(buildRailPassPopupHtml({ configured: false, passes: [] }), /not configured/i);
  assert.match(buildRailPassPopupHtml({ configured: true, passes: [] }), /No scheduled passenger trains/i);
});

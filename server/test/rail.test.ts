import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import {
  fetchRailNetwork,
  getCachedRail,
  mapIndustrialElements,
  mapRailElements,
  railLinesFromGeoJson,
  runRailTask,
} from '../src/sources/rail.js';
import { OverpassClient } from '../src/sources/overpass.js';

test('mapRailElements and mapIndustrialElements: pure mapping and deduplication', () => {
  const railEls = [
    { type: 'way' as const, id: 10, tags: { usage: 'main', service: '' }, geometry: [{ lat: -33.4, lon: 149.5 }, { lat: -33.41, lon: 149.51 }] },
    { type: 'way' as const, id: 10, tags: { usage: 'main' }, geometry: [{ lat: -33.4, lon: 149.5 }, { lat: -33.41, lon: 149.51 }] }, // duplicate
  ];
  const railFeatures = mapRailElements(railEls as any);
  assert.equal(railFeatures.length, 1);
  assert.equal(railFeatures[0].properties?.id, 'way/10');

  const indEls = [
    { type: 'node' as const, id: 20, lat: -33.42, lon: 149.52, tags: { industrial: 'mine', name: 'Coal Mine' } },
    { type: 'way' as const, id: 30, center: { lat: -33.43, lon: 149.53 }, tags: { man_made: 'works', name: 'Steelworks' } },
    { type: 'node' as const, id: 20, lat: -33.42, lon: 149.52, tags: { industrial: 'mine' } }, // duplicate
  ];
  const indFeatures = mapIndustrialElements(indEls as any);
  assert.equal(indFeatures.length, 2);
  assert.equal(indFeatures[0].properties?.id, 'node/20');
  assert.equal(indFeatures[0].properties?.kind, 'mine');
  assert.equal(indFeatures[1].properties?.id, 'way/30');
  assert.equal(indFeatures[1].properties?.kind, 'works');
});

test('fetchRailNetwork: tiles area, processes serially, and dedupes across tiles', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const queries: string[] = [];

  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    const body = String(init?.body ?? '');
    const ql = decodeURIComponent(body.replace(/^data=/, ''));
    queries.push(ql);

    await new Promise((r) => setTimeout(r, 2));

    let elements: any[] = [];
    if (ql.includes('"railway"="rail"')) {
      // Overlapping way returned across tiles
      elements = [
        { type: 'way', id: 101, tags: { usage: 'main' }, geometry: [{ lat: -33.4, lon: 149.5 }, { lat: -33.5, lon: 149.6 }] },
      ];
    } else if (ql.includes('"landuse"="industrial"')) {
      elements = [
        { type: 'node', id: 202, lat: -33.45, lon: 149.55, tags: { industrial: 'mine', name: 'Mine A' } },
      ];
    }

    inFlight--;
    return new Response(JSON.stringify({ elements }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
  });

  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 60 }];
  const fc = await fetchRailNetwork(areas, { client, maxTileKm: 50 });

  // Must run serially: no parallel fan-out
  assert.equal(maxConcurrent, 1);

  // Way 101 returned on multiple tiles is deduped to 1 feature
  const ways = fc.features.filter((f) => f.properties?.kind === 'rail');
  assert.equal(ways.length, 1);
  assert.equal(ways[0].properties?.id, 'way/101');

  const sites = fc.features.filter((f) => f.properties?.kind !== 'rail');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].properties?.id, 'node/202');
});

test('runRailTask: preserves last-known-good rail cache on failure and returns diagnostic', async () => {
  const db = createDb(':memory:');
  const existingGeoJson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'way/999', kind: 'rail', usage: 'main', service: '', name: 'Main Western Line' },
        geometry: { type: 'LineString', coordinates: [[149.5, -33.4], [149.6, -33.5]] },
      },
    ],
  };

  // Seed last-known-good cache
  db.setKv('rail:geojson', JSON.stringify(existingGeoJson));
  assert.equal(getCachedRail(db).features.length, 1);

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  // Mock fetch fails with timeout
  const mockFetch = (async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 0,
  });

  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 20 }];
  const result = await runRailTask(db, areas, log, { client });

  // Result reports failure with diagnostic
  assert.equal(result.ok, false);
  assert.match(result.message, /timeout/);
  assert.match(result.message, /overpass-api\.de/);
  assert.match(result.message, /rail/);

  // Last-known-good cache is preserved intact!
  const cachedAfter = getCachedRail(db);
  assert.equal(cachedAfter.features.length, 1);
  assert.equal(cachedAfter.features[0].properties?.id, 'way/999');

  // Verify railLinesFromGeoJson helper still extracts lines correctly
  const lines = railLinesFromGeoJson(cachedAfter);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ref, 'way/999');
});

test('fetchRailNetwork: enforces request pacing across rail and industrial queries', async () => {
  let currentTime = 1000;
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
    currentTime += ms;
  };
  const mockNow = () => currentTime;

  const mockFetch = (async () => {
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: mockSleep,
    now: mockNow,
    paceMs: 600,
  });

  // Area with radiusKm=20 produces 1 tile
  // 1 rail query + 1 industrial query = 2 sequential queries
  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 20 }];
  await fetchRailNetwork(areas, { client, maxTileKm: 50 });

  // Query 1 has no wait, query 2 waits 600ms
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0], 600);
});

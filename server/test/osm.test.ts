import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_CATEGORIES,
  candidateCategoryQuery,
  fetchCandidates,
  mapCandidateElements,
  runCandidatesTask,
} from '../src/sources/osm.js';
import { OverpassClient } from '../src/sources/overpass.js';

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

test('candidateCategoryQuery: defines separate queries for each semantic category', () => {
  const bbox = { south: -34, west: 149, north: -33, east: 150 };
  for (const cat of CANDIDATE_CATEGORIES) {
    const ql = candidateCategoryQuery(cat, bbox);
    assert.ok(ql.startsWith('[out:json][timeout:60];'));
    assert.ok(ql.includes('-34,149,-33,150'));
  }
  // Verify specific category keywords
  assert.ok(candidateCategoryQuery('viewpoints', bbox).includes('"tourism"="viewpoint"'));
  assert.ok(candidateCategoryQuery('ruins', bbox).includes('"historic"="ruins"'));
  assert.ok(candidateCategoryQuery('abandoned_disused', bbox).includes('^(abandoned|disused):'));
});

test('fetchCandidates: tiles area, processes categories serially, and dedupes across tiles', async () => {
  const queryLog: { category?: string; ql: string }[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    const body = String(init?.body ?? '');
    const ql = decodeURIComponent(body.replace(/^data=/, ''));
    // Small artificial delay to verify serial execution
    await new Promise((r) => setTimeout(r, 2));

    let elements: any[] = [];
    if (ql.includes('"tourism"="viewpoint"')) {
      // Return viewpoint on both tiles to verify deduplication
      elements = [{ type: 'node', id: 101, lat: -33.4, lon: 149.5, tags: { tourism: 'viewpoint', name: 'Mount Panorama' } }];
    } else if (ql.includes('"historic"="ruins"')) {
      elements = [{ type: 'way', id: 202, center: { lat: -33.41, lon: 149.51 }, tags: { historic: 'ruins', name: 'Old Mill' } }];
    }

    inFlight--;
    return new Response(JSON.stringify({ elements }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
  });

  // Area with radiusKm=60 will produce multiple tiles with maxTileKm=50
  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 60 }];
  const rows = await fetchCandidates(areas, { client, maxTileKm: 50 });

  // Strictly serial: never parallel requests
  assert.equal(maxConcurrent, 1);

  // Even though Mount Panorama was returned in every tile viewpoint query, it's deduped
  const viewpoints = rows.filter((r) => r.ref === 'node/101');
  assert.equal(viewpoints.length, 1);
  assert.equal(viewpoints[0].name, 'Mount Panorama');

  const ruins = rows.filter((r) => r.ref === 'way/202');
  assert.equal(ruins.length, 1);
});

test('runCandidatesTask: preserves pre-existing candidates and isolates failing category', async () => {
  const { createDb } = await import('../src/db.js');
  // Use in-memory SQLite database
  const db = createDb(':memory:');

  // Insert pre-existing candidate
  db.handle.prepare(
    `INSERT INTO candidates (id, source, ref, name, lat, lng, tags, fetched_at)
     VALUES ('existing-1', 'osm', 'node/999', 'Existing Lookout', -33.4, 149.5, '{}', '2026-01-01T00:00:00.000Z')`
  ).run();

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  // Mock fetch: viewpoints succeeds, but abandoned_disused times out
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const ql = decodeURIComponent(body.replace(/^data=/, ''));
    if (ql.includes('^(abandoned|disused):')) {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (ql.includes('"tourism"="viewpoint"')) {
      return new Response(JSON.stringify({
        elements: [{ type: 'node', id: 555, lat: -33.42, lon: 149.58, tags: { tourism: 'viewpoint', name: 'New Scenic Peak' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 0,
  });

  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 20 }];
  const result = await runCandidatesTask(db, areas, log, { client });

  // Task reports failed because a category failed, but identifies the category
  assert.equal(result.ok, false);
  assert.match(result.message, /abandoned_disused/);
  assert.match(result.message, /overpass-api\.de/);
  assert.match(result.message, /timeout/);

  // Pre-existing candidate is still present!
  const rows = db.handle.prepare('SELECT * FROM candidates ORDER BY ref ASC').all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ref, 'node/555');
  assert.equal(rows[0].name, 'New Scenic Peak');
  assert.equal(rows[1].ref, 'node/999');
  assert.equal(rows[1].name, 'Existing Lookout');
});

test('runCandidatesTask: full failure preserves pre-existing candidates and reports diagnostic', async () => {
  const { createDb } = await import('../src/db.js');
  const db = createDb(':memory:');

  db.handle.prepare(
    `INSERT INTO candidates (id, source, ref, name, lat, lng, tags, fetched_at)
     VALUES ('existing-1', 'osm', 'node/999', 'Existing Lookout', -33.4, 149.5, '{}', '2026-01-01T00:00:00.000Z')`
  ).run();

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  // All requests fail with 503
  const mockFetch = (async () => {
    return new Response('Service Unavailable', { status: 503 });
  }) as typeof fetch;

  const client = new OverpassClient({
    endpoints: ['https://overpass-api.de/api/interpreter'],
    fetch: mockFetch,
    sleep: async () => {},
    maxRetriesPerEndpoint: 0,
  });

  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 20 }];
  const result = await runCandidatesTask(db, areas, log, { client });

  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 503/);
  assert.match(result.message, /overpass-api\.de/);

  // Pre-existing candidate remains intact
  const rows = db.handle.prepare('SELECT * FROM candidates').all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, 'node/999');
});

test('fetchCandidates: enforces request pacing across categories and tiles', async () => {
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
    paceMs: 500,
  });

  // Area with radiusKm=20 produces 1 tile per category
  // 5 categories * 1 tile = 5 sequential queries
  const areas = [{ lat: -33.419, lng: 149.577, radiusKm: 20 }];
  await fetchCandidates(areas, { client, maxTileKm: 50 });

  // Exactly 5 queries made: query 1 has no wait, queries 2-5 wait 500ms each
  assert.equal(sleepCalls.length, 4);
  for (const wait of sleepCalls) {
    assert.equal(wait, 500);
  }
});

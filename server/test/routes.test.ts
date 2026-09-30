import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import {
  parseRouteStaging,
  parseRouteVertices,
  routeJson,
  type RouteRow,
} from '../src/routes.js';

type Visibility = 'private' | 'unlisted' | 'public';
type RouteType = 'sprint' | 'circuit';

function insertRoute(
  db: ReturnType<typeof createDb>,
  opts: {
    id?: string;
    ownerId?: string;
    name?: string;
    notes?: string;
    access?: string;
    type?: RouteType;
    vertices?: [number, number][];
    staging?: { lat: number; lng: number } | null;
    visibility?: Visibility;
  } = {},
) {
  const id = opts.id ?? 'r1';
  const now = new Date().toISOString();
  db.handle
    .prepare(
      'INSERT INTO routes (id, owner_id, name, notes, access, type, vertices, staging, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      opts.ownerId ?? 'u1',
      opts.name ?? 'Test Route',
      opts.notes ?? '',
      opts.access ?? '',
      opts.type ?? 'sprint',
      JSON.stringify(opts.vertices ?? [[151.2, -33.8], [151.3, -33.7]]),
      opts.staging ? JSON.stringify(opts.staging) : null,
      opts.visibility ?? 'private',
      now,
      now,
    );
  return id;
}

function getRoute(db: ReturnType<typeof createDb>, id = 'r1'): RouteRow {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow | undefined;
  assert.ok(row, `expected route ${id}`);
  return row;
}

test('routes: a persisted route round-trips ordered vertices, type, staging and visibility', () => {
  const db = createDb(':memory:');
  insertRoute(db, {
    vertices: [[151.2, -33.8], [151.3, -33.7], [151.4, -33.6]],
    type: 'circuit',
    staging: { lat: -33.85, lng: 151.15 },
    visibility: 'public',
  });

  const out = routeJson(getRoute(db));
  assert.equal(out.type, 'circuit');
  assert.deepEqual(out.vertices, [[151.2, -33.8], [151.3, -33.7], [151.4, -33.6]]);
  assert.deepEqual(out.staging, { lat: -33.85, lng: 151.15 });
  assert.equal(out.visibility, 'public');
});

test('routes: staging is nullable and separate from route vertices', () => {
  const db = createDb(':memory:');
  insertRoute(db, { type: 'sprint', staging: null });

  const out = routeJson(getRoute(db));
  assert.equal(out.staging, null);
  assert.deepEqual(out.vertices, [[151.2, -33.8], [151.3, -33.7]]);
});

test('routes: can update vertices and type without reordering vertices', () => {
  const db = createDb(':memory:');
  insertRoute(db);
  const newVertices: [number, number][] = [[0, 0], [1, 1], [2, 2], [3, 3]];

  db.handle.prepare('UPDATE routes SET vertices = ?, type = ? WHERE id = ?').run(
    JSON.stringify(newVertices), 'circuit', 'r1',
  );

  const out = routeJson(getRoute(db));
  assert.equal(out.type, 'circuit');
  assert.deepEqual(out.vertices, newVertices);
});

test('routes: can delete a route', () => {
  const db = createDb(':memory:');
  insertRoute(db);

  db.handle.prepare('DELETE FROM routes WHERE id = ?').run('r1');

  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get('r1');
  assert.equal(row, undefined);
});

test('routes: multiple routes list in name order', () => {
  const db = createDb(':memory:');
  insertRoute(db, { id: 'r1', name: 'Zeta Route' });
  insertRoute(db, { id: 'r2', name: 'Alpha Route' });
  insertRoute(db, { id: 'r3', name: 'Beta Route' });

  const rows = db.handle.prepare('SELECT id FROM routes ORDER BY name').all() as unknown as { id: string }[];

  assert.deepEqual(rows.map((r) => r.id), ['r2', 'r3', 'r1']);
});

test('routes: vertex validation requires finite [lng, lat] pairs in bounds', () => {
  assert.deepEqual(parseRouteVertices([[151.2, -33.8], [151.3, -33.7]]), [[151.2, -33.8], [151.3, -33.7]]);
  assert.throws(() => parseRouteVertices('bad'), /vertices must be an array/);
  assert.throws(() => parseRouteVertices([[151.2, 'bad']]), /vertex 1 must be \[lng, lat\] numbers/);
  assert.throws(() => parseRouteVertices([[181, -33.8]]), /outside valid lng\/lat bounds/);
});

test('routes: staging validation accepts null or finite lat/lng in bounds', () => {
  assert.equal(parseRouteStaging(null), null);
  assert.deepEqual(parseRouteStaging({ lat: -33.85, lng: 151.15 }), { lat: -33.85, lng: 151.15 });
  assert.throws(() => parseRouteStaging({ lat: -33.85 }), /staging must be null or \{ lat, lng \}/);
  assert.throws(() => parseRouteStaging({ lat: -91, lng: 151.15 }), /staging is outside valid lat\/lng bounds/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { coverFields, SPOT_COVER_COLS } from '../src/photos.js';

test('spot payload carries photo count and cover thumb (location photo first, else earliest)', () => {
  const db = createDb(':memory:');
  const spot = (id: string) => db.handle.prepare(
    `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
     VALUES (?, NULL, 'u', ?, '', 0, 0, '[]', NULL, NULL, '{}', 'public', 'manual', '', 't', 't')`).run(id, id);
  const photo = (id: string, spotId: string, kind: string, at: string) => db.handle.prepare(
    `INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, created_at) VALUES (?, ?, 'u', ?, 'f', 't', ?)`).run(id, spotId, kind, at);
  spot('a'); spot('b'); spot('c');
  photo('a1', 'a', 'taken_here', '2024-01-01');
  photo('a2', 'a', 'of_location', '2024-02-01');
  photo('a3', 'a', 'of_location', '2024-03-01');
  photo('b1', 'b', 'taken_here', '2024-02-01');
  photo('b0', 'b', 'taken_here', '2024-01-01');
  const rows = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots ORDER BY id`).all() as any[];
  assert.deepEqual(rows.map((r) => ({ id: r.id, ...coverFields(r) })), [
    { id: 'a', photoCount: 3, coverThumbUrl: '/api/photos/a2/thumb' },
    { id: 'b', photoCount: 2, coverThumbUrl: '/api/photos/b0/thumb' },
    { id: 'c', photoCount: 0, coverThumbUrl: null },
  ]);
});

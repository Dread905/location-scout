import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDb } from '../src/db.js';
import { buildFeatureCollection, upsertBundle } from '../src/share.js';

// A minimal, valid JPEG-by-magic-bytes buffer, so saveImage() accepts it
// without a real photo. Stands in for a network fetch in these tests.
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

test('share bundle round-trip: build on one instance, upsert into another', async () => {
  const source = createDb(':memory:');
  const sourceOwner = crypto.randomUUID();
  const now = new Date().toISOString();

  const placeId = crypto.randomUUID();
  source.handle
    .prepare('INSERT INTO places (id, owner_id, name, notes, access, lat, lng, visibility, source, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(placeId, sourceOwner, 'Mount Panorama', '', '', -33.427, 149.552, 'public', 'manual', '', now, now);

  const spotId = crypto.randomUUID();
  source.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(spotId, placeId, sourceOwner, 'Skyline', 'great at sunset', -33.429, 149.549, '["lookout"]', 270, 60,
      JSON.stringify({ phases: ['golden_pm'], months: [], days: 'any', conditions: [], eventKeywords: [], avoid: '', notes: '' }),
      'public', 'manual', '', now, now);

  const photoId = crypto.randomUUID();
  source.handle
    .prepare('INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, w, h, taken_at, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)')
    .run(photoId, spotId, sourceOwner, 'taken_here', 'source-file.jpg', 'source-thumb.jpg', 'looking north', now);

  const bundle = buildFeatureCollection(source, sourceOwner, (id, variant) => `http://source.example/api/photos/${id}/${variant}`);
  assert.equal(bundle.features.filter((f) => f.properties.kind === 'place').length, 1);
  assert.equal(bundle.features.filter((f) => f.properties.kind === 'spot').length, 1);

  const target = createDb(':memory:');
  const targetOwner = crypto.randomUUID();
  const remoteId = 'remote-1';
  const fetchPhoto = async () => Buffer.from(fakeJpeg);

  const first = await upsertBundle(target, bundle, targetOwner, remoteId, fetchPhoto);
  assert.equal(first.places, 1);
  assert.equal(first.spots, 1);

  const spotRow = target.handle.prepare("SELECT * FROM spots WHERE source = 'remote'").get() as any;
  assert.equal(spotRow.name, 'Skyline');
  assert.equal(spotRow.source_ref, `${remoteId}:${spotId}`);
  assert.equal(spotRow.owner_id, targetOwner);
  assert.equal(JSON.parse(spotRow.good_times).phases[0], 'golden_pm');

  const placeRow = target.handle.prepare("SELECT * FROM places WHERE source = 'remote'").get() as any;
  assert.equal(spotRow.place_id, placeRow.id); // placeId remapped to the local place's id

  const photoRow = target.handle.prepare('SELECT * FROM photos WHERE spot_id = ?').get(spotRow.id) as any;
  assert.ok(photoRow, 'the spot\'s photo was downloaded and saved');

  // Re-syncing an updated bundle upserts in place rather than duplicating.
  (bundle.features.find((f) => f.properties.kind === 'spot')!.properties as any).name = 'Skyline (renamed)';
  const second = await upsertBundle(target, bundle, targetOwner, remoteId, fetchPhoto);
  assert.equal(second.spots, 1);
  const spotCount = (target.handle.prepare('SELECT COUNT(*) AS n FROM spots').get() as { n: number }).n;
  assert.equal(spotCount, 1, 'no duplicate row on resync');
  const updated = target.handle.prepare('SELECT name FROM spots WHERE id = ?').get(spotRow.id) as { name: string };
  assert.equal(updated.name, 'Skyline (renamed)');
});

test('share bundle: manual freight sightings are no longer exported', () => {
  const source = createDb(':memory:');
  const sourceOwner = crypto.randomUUID();
  source.handle
    .prepare('INSERT INTO sightings (id, owner_id, kind, direction, lat, lng, line_ref, seen_at, notes, visibility, source, source_ref, loaded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), sourceOwner, 'coal', 'up', -33.47, 150.15, 'way/123', new Date().toISOString(), '', 'public', 'manual', '', 1);
  const bundle = buildFeatureCollection(source, sourceOwner, (id, variant) => `http://source.example/api/photos/${id}/${variant}`);
  assert.equal(bundle.features.length, 0);
});

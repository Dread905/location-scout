import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Spot } from '../src/api.js';
import { compass, escapeHtml, excerpt, glanceHtml, glanceOffset, goodStatus, thumbIconId, THUMB_PREFIX } from '../src/map/spotGlance.js';
import { categoryOf } from '../src/map/legend.js';

const gt = { phases: [], months: [], days: 'any', conditions: [], eventKeywords: [], avoid: '', notes: '' };
const spot = (over: Partial<Spot> = {}): Spot => ({
  id: 's', placeId: null, ownerId: 'u', name: 'Lookout', notes: '', lat: -33.42, lng: 149.58, tags: [], facingDeg: null, fovDeg: null,
  goodTimes: gt as any, visibility: 'public', source: 'manual', sourceRef: '', createdAt: '', updatedAt: '', ...over,
});

test('thumb icon id', () => {
  assert.equal(thumbIconId('/api/photos/x/thumb'), `${THUMB_PREFIX}/api/photos/x/thumb`);
  assert.equal(thumbIconId(null), '');
  assert.equal(thumbIconId(undefined), '');
});

test('compass and excerpt', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(359), 'N');
  assert.equal(compass(270), 'W');
  assert.equal(compass(-45), 'NW');
  assert.equal(excerpt('short  note\n'), 'short note');
  const long = 'word '.repeat(40);
  const e = excerpt(long, 30);
  assert.ok(e.endsWith('…') && e.length <= 31, e);
});

test('good status: none, now, next', () => {
  assert.equal(goodStatus(spot(), new Date()), null);
  const all = spot({ goodTimes: { ...gt, phases: ['day', 'night', 'blue', 'golden_am', 'golden_pm'] } as any });
  assert.deepEqual(goodStatus(all, new Date(2025, 0, 15, 12)), { now: true, text: 'Good now' });
  const pm = spot({ goodTimes: { ...gt, phases: ['golden_pm'] } as any });
  const s = goodStatus(pm, new Date(2025, 0, 15, 3))!;
  assert.equal(s.now, false);
  assert.match(s.text, /^Next: (Golden PM|Sunset) · /);
});

test('glance card html: escapes, thumbnail, meta, tags, notes', () => {
  const html = glanceHtml(spot({ name: '<b>Hill</b>', coverThumbUrl: '/api/photos/p/thumb', photoCount: 2, facingDeg: 90, tags: ['sunset'], notes: 'Park & walk' }),
    { time: new Date(2025, 0, 15, 12), home: { lat: -33.42, lng: 149.58 } });
  assert.match(html, /<img class="glance__img" src="\/api\/photos\/p\/thumb"/);
  assert.match(html, /&lt;b&gt;Hill&lt;\/b&gt;/);
  assert.match(html, /Facing E \(90°\) · 0\.0 km from home · 2 photos/);
  assert.match(html, /<span>sunset<\/span>/);
  assert.match(html, /Park &amp; walk/);
  const bare = glanceHtml(spot(), { time: new Date() });
  assert.ok(!bare.includes('<img') && !bare.includes('glance__meta') && !bare.includes('glance__good'));
  assert.ok(glanceOffset(true) > glanceOffset(false));
  assert.equal(escapeHtml(`"'`), '&quot;&#39;');
});

test('legend groups the thumbnail layers with spots', () => {
  for (const id of ['spot-points', 'spot-thumbs', 'place-spot-thumbs', 'spot-label'])
    assert.equal(categoryOf({ id, type: 'symbol', source: 'spots' }), 'spots');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGpx } from '../src/gpx.js';

test('buildGpx: produces one wpt per waypoint with lat/lon and an escaped name', () => {
  const gpx = buildGpx([
    { lat: -33.419, lng: 149.577, name: 'Skyline', desc: 'best at golden hour' },
    { lat: -33.42, lng: 149.58, name: 'Tom & Jerry\'s <lookout>' },
  ]);
  assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /<wpt lat="-33.419" lon="149.577">/);
  assert.match(gpx, /<name>Skyline<\/name>/);
  assert.match(gpx, /<desc>best at golden hour<\/desc>/);
  // & < > are escaped so the file stays valid XML.
  assert.match(gpx, /Tom &amp; Jerry&apos;s &lt;lookout&gt;/);
  assert.equal((gpx.match(/<wpt /g) ?? []).length, 2);
});

test('buildGpx: an empty list is still valid, empty gpx', () => {
  const gpx = buildGpx([]);
  assert.match(gpx, /<gpx[^>]*>\s*<\/gpx>/);
});

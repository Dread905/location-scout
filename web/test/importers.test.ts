import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvToRows, geoJsonToRows, isDuplicate, parseCsv, rowsToFeatureCollection } from '../src/importers.js';

test('parseCsv: quoted commas, doubled quotes, newlines in quotes, CRLF', () => {
  const rows = parseCsv('name,lat,lng,notes\r\n"Skyline, top",-33.44,149.55,"say ""hi""\nthere"\r\nPlain,1,2,\r\n');
  assert.deepEqual(rows, [
    ['name', 'lat', 'lng', 'notes'],
    ['Skyline, top', '-33.44', '149.55', 'say "hi"\nthere'],
    ['Plain', '1', '2', ''],
  ]);
});

test('csvToRows: header or headerless name,lat,lng,notes; skips bad rows', () => {
  const rows = csvToRows('"The Chase, Mt Panorama",-33.45,149.56,fast corner\nbad,x,y,\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'The Chase, Mt Panorama');
  assert.equal(rows[0].lat, -33.45);
  assert.equal(rows[0].notes, 'fast corner');
  const headed = csvToRows('Latitude,Longitude,Title\n-33.4,149.5,Hill\n');
  assert.deepEqual([headed[0].name, headed[0].lat, headed[0].lng], ['Hill', -33.4, 149.5]);
});

test('geoJsonToRows: Google Takeout saved places, including coordinates only in the URL', () => {
  const takeout = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [149.5775, -33.4193] },
        properties: { date: '2024-01-01', google_maps_url: 'http://maps.google.com/?cid=1', location: { name: 'Machattie Park', address: 'William St, Bathurst' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { google_maps_url: 'https://www.google.com/maps/search/?q=-33.4489,149.5566', location: { address: 'Mount Panorama' } } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [149.1, -33.2] },
        properties: { Title: 'Old style', 'Google Maps URL': 'x', Location: { 'Business Name': 'Old style', Address: 'Orange NSW' } } },
    ],
  };
  const rows = geoJsonToRows(takeout);
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.lat, r.lng]), [
    ['spot', 'Machattie Park', -33.4193, 149.5775],
    ['spot', 'Mount Panorama', -33.4489, 149.5566],
    ['spot', 'Old style', -33.2, 149.1],
  ]);
  assert.equal(rows[0].notes, 'William St, Bathurst');
});

test('geoJsonToRows: togeojson GPX output, waypoints become spots and tracks become places', () => {
  // What @tmcw/togeojson's gpx() returns for one <wpt> and one <trk>.
  const fromGpx = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [149.55, -33.44, 800] }, properties: { name: 'Skyline', desc: 'Top of the mountain' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[149.55, -33.44], [149.56, -33.45], [149.57, -33.44]] }, properties: { name: 'Lap' } },
    ],
  };
  const rows = geoJsonToRows(fromGpx);
  assert.deepEqual([rows[0].kind, rows[0].name, rows[0].notes, rows[0].lat], ['spot', 'Skyline', 'Top of the mountain', -33.44]);
  assert.equal(rows[1].kind, 'place');
  assert.equal(rows[1].geom?.type, 'LineString');
  assert.ok(Math.abs(rows[1].lng - 149.56) < 1e-9);

  const fc = rowsToFeatureCollection(rows);
  assert.deepEqual(fc.features[0].geometry.coordinates, [149.55, -33.44]);
  assert.equal(fc.features[1].properties.kind, 'place');
});

test('geoJsonToRows: a Location Scout export keeps its extra properties', () => {
  const rows = geoJsonToRows({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { kind: 'spot', id: 'a', name: 'S', notes: '', facingDeg: 250, goodTimes: { phases: ['sunset'] }, photos: [] } }] });
  assert.equal(rows[0].extra.facingDeg, 250);
  assert.equal('photos' in rows[0].extra, false);
});

test('isDuplicate: same name within 50 m only', () => {
  const existing = [{ name: 'Skyline', lat: -33.44, lng: 149.55 }];
  const row = (name: string, lat: number) => ({ kind: 'spot' as const, name, lat, lng: 149.55, notes: '', geom: null, extra: {} });
  assert.equal(isDuplicate(row('skyline ', -33.4403), existing), true); // ~33 m
  assert.equal(isDuplicate(row('Skyline', -33.441), existing), false); // ~110 m
  assert.equal(isDuplicate(row('Other', -33.44), existing), false);
});

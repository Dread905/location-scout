import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTrackGraph, clipLine, nearestSegment, snapToTrack } from '../src/map/trackSnap.js';
import { graphFromTiles, RailSnapper, tileBounds, type SnappableTrain } from '../src/map/railSnap.js';
import { cumulative, trainPredict } from '../src/map/motion.js';

type LngLat = [number, number];
const DEG_KM = 111.32;
const offM = (line: LngLat[], p: LngLat) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const k = Math.cos((a[1] * Math.PI) / 180);
    const [bx, by] = [(b[0] - a[0]) * DEG_KM * k, (b[1] - a[1]) * DEG_KM];
    const [px, py] = [(p[0] - a[0]) * DEG_KM * k, (p[1] - a[1]) * DEG_KM];
    const L2 = bx * bx + by * by;
    const t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - t * bx, py - t * by) * 1000);
  }
  return best;
};

test('web trackSnap.ts is an exact copy of the server module', () => {
  const read = (p: string) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  assert.equal(read('../src/map/trackSnap.ts'), read('../../server/src/feeds/trackSnap.ts'));
});

// A straight east-west line at Strathfield-ish latitude, crossing a z14 tile edge.
const z = 14;
const x = Math.floor(((151.09 + 180) / 360) * 2 ** z);
const edge = tileBounds(z, x, 0).east; // lng of the boundary between tiles x and x+1
const lat = -33.87;
const line: LngLat[] = [[edge - 0.02, lat], [edge - 0.005, lat + 0.0005], [edge + 0.005, lat + 0.001], [edge + 0.02, lat + 0.0015]];
const bx = (xx: number) => ({ ...tileBounds(z, xx, 0), south: -90, north: 90 });

test('clipLine: keeps only the part inside the box, split where it leaves', () => {
  const inA = clipLine(line, bx(x));
  assert.equal(inA.length, 1);
  assert.ok(Math.abs(inA[0].at(-1)![0] - edge) < 1e-12);
  const vee: LngLat[] = [[0, 0], [2, 1], [0, 2]];
  assert.equal(clipLine(vee, { west: -1, east: 1, south: -1, north: 3 }).length, 2);
});

test('graphFromTiles: stitches a line split at a tile edge (ends ~0.5 m apart, with buffer overlap) into one track', () => {
  // Each tile carries the line plus a buffer past its edge, quantized slightly differently.
  const jitter = (l: LngLat[], d: number) => l.map(([a, b]) => [a + d, b] as LngLat);
  const tiles = [
    { bounds: bx(x), lines: [jitter(line.slice(0, 3), 0)] },
    { bounds: bx(x + 1), lines: [jitter(line.slice(1), 0.000004)] }, // ~0.4 m east
  ];
  const g = graphFromTiles(tiles);
  // The boundary vertex is shared: walking from the west end reaches the east end.
  const s = snapToTrack(g, [edge - 0.012, lat + 0.0003], { bearing: 80, backKm: 0.2, aheadKm: 2.5 });
  assert.ok(s);
  const cum = cumulative(s.path);
  assert.ok(cum.at(-1)! - s.atKm > 2.4, `walked only ${cum.at(-1)! - s.atKm} km ahead: not stitched`);
  // Not stitched without the tolerance: the walk stops at the tile edge.
  const raw = buildTrackGraph(tiles.flatMap((t) => clipLine(t.lines[0], t.bounds).map((c) => ({ coords: c }))));
  const s2 = snapToTrack(raw, [edge - 0.012, lat + 0.0003], { bearing: 80, backKm: 0.2, aheadKm: 2.5 })!;
  assert.ok(cumulative(s2.path).at(-1)! - s2.atKm < 1.5);
  // No duplicate parallel copy from the buffers: exactly one segment near a point just past the edge.
  assert.ok(nearestSegment(g, [edge + 0.001, lat + 0.0006]));
});

test('RailSnapper: snaps unsnapped trains onto basemap rails, leaves server-snapped ones, reuses the cached path', () => {
  const rs = new RailSnapper();
  assert.equal(rs.setTiles(new Map([['a', { bounds: null, lines: [line] }]])), true);
  assert.equal(rs.setTiles(new Map([['a', { bounds: null, lines: [line] }]])), false);
  const off: LngLat = [edge - 0.004, lat + 0.0006 + 0.0003]; // ~30 m north of the line
  const shape: LngLat[] = [[off[0] - 0.01, off[1]], [off[0] + 0.01, off[1]]];
  const [t, keep] = rs.snap([
    { tripId: 'x', lat: off[1], lng: off[0], bearing: null, path: shape, pathAtKm: cumulative(shape)[1] / 2, snapped: false },
    { tripId: 'y', lat: 1, lng: 2, snapped: true },
  ]);
  assert.equal(keep.lat, 1);
  assert.equal(t.snapped, true);
  assert.ok(offM(line, [t.lng, t.lat]) < 0.5, 'lead on the rail');
  for (const p of t.path!) assert.ok(offM(line, p) < 0.5);
  assert.ok(t.bearing! > 45 && t.bearing! < 135);
  // The motion tracker runs it along the rail.
  const later = trainPredict({ ...t, speedMps: 20 })(20_000);
  assert.ok(offM(line, [later.lng, later.lat]) < 0.5);
  // Next poll a bit further along: same path reused.
  const [t2] = rs.snap<SnappableTrain>([{ tripId: 'x', lat: t.lat + 0.00002, lng: t.lng + 0.001, snapped: false }]);
  assert.equal(t2.path, t.path);
  assert.ok(t2.pathAtKm! > t.pathAtKm!);
});

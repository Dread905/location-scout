import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route } from '../src/api.js';
import {
  ROUTE_LAYERS,
  routeDashPalette,
  routeFeatureCollections,
  routePulseGradient,
} from '../src/map/routeLayer.js';

const route = (patch: Partial<Route>): Route => ({
  id: 'r1',
  ownerId: 'u1',
  name: 'Ridge run',
  notes: '',
  access: '',
  type: 'sprint',
  vertices: [[151.1, -33.1], [151.2, -33.2], [151.3, -33.3]],
  staging: null,
  visibility: 'private',
  createdAt: '',
  updatedAt: '',
  ...patch,
});

test('routeFeatureCollections emits one selectable directed LineString per route', () => {
  const { segments } = routeFeatureCollections([route({ type: 'circuit' })], 'r1');

  assert.equal(segments.features.length, 1);
  assert.deepEqual(segments.features[0].properties, {
    id: 'r1',
    routeId: 'r1',
    type: 'circuit',
    selected: true,
  });
  assert.deepEqual(segments.features[0].geometry, {
    type: 'LineString',
    coordinates: [[151.1, -33.1], [151.2, -33.2], [151.3, -33.3], [151.1, -33.1]],
  });
});

test('routeFeatureCollections emits staging points only when a route has staging coordinates', () => {
  const { staging } = routeFeatureCollections([
    route({ id: 'with-stage', staging: { lat: -33.4, lng: 151.4 } }),
    route({ id: 'without-stage', staging: null }),
  ], 'with-stage');

  assert.equal(staging.features.length, 1);
  assert.deepEqual(staging.features[0].properties, { id: 'with-stage', routeId: 'with-stage', selected: true });
  assert.deepEqual(staging.features[0].geometry, { type: 'Point', coordinates: [151.4, -33.4] });
});

test('routeFeatureCollections keeps a long route as one LineString instead of one feature per leg', () => {
  const vertices = Array.from({ length: 1_001 }, (_, i) => [151 + i / 10_000, -33 - i / 10_000] as [number, number]);
  const { segments } = routeFeatureCollections([route({ vertices })], null);

  assert.equal(segments.features.length, 1);
  assert.deepEqual(segments.features[0].geometry, { type: 'LineString', coordinates: vertices });
});

test('route animation palette changes foreground by sun altitude and keeps opposite halo contrast', () => {
  assert.deepEqual(routeDashPalette(35), { foreground: '#111827', halo: '#fff7ed' });
  assert.deepEqual(routeDashPalette(1), { foreground: '#fef08a', halo: '#05070f' });
  assert.deepEqual(routeDashPalette(-12), { foreground: '#f8fafc', halo: '#05070f' });
});

test('routePulseGradient uses transparent bookends around the visible pulse', () => {
  const gradient = routePulseGradient(0.5, '#f8fafc') as unknown[];
  assert.equal(gradient[0], 'interpolate');
  assert.ok(gradient.includes('#f8fafc'));
  assert.equal(gradient[4], '#f8fafc00');
  assert.equal(gradient.at(-1), '#f8fafc00');
});

test('ROUTE_LAYERS includes every rendered route overlay layer', () => {
  assert.deepEqual([...ROUTE_LAYERS], [
    'route-glow',
    'route-casing',
    'route-lines',
    'route-dash-casing',
    'route-dashes',
    'route-staging-halo',
    'route-staging',
  ]);
});

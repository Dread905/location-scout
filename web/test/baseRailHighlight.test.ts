import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBaseRailHighlight,
  baseRailLayerIds,
  effectiveRailOn,
  restoreBaseRailHighlight,
  type BaseRailMap,
} from '../src/map/baseRailHighlight.js';

type Layer = NonNullable<ReturnType<BaseRailMap['getStyle']>['layers']>[number];

class FakeMap implements BaseRailMap {
  layers: Layer[];
  paint = new Map<string, Record<string, unknown>>();
  writes: { id: string; prop: string; value: unknown }[] = [];

  constructor(layers: Layer[]) {
    this.layers = layers;
    for (const layer of layers) this.paint.set(layer.id, { ...(layer.paint ?? {}) });
  }

  getStyle() {
    return { layers: this.layers };
  }

  getLayer(id: string) {
    return this.layers.find((layer) => layer.id === id);
  }

  getPaintProperty(id: string, prop: string) {
    return this.paint.get(id)?.[prop];
  }

  setPaintProperty(id: string, prop: string, value: unknown) {
    this.writes.push({ id, prop, value });
    const next = { ...(this.paint.get(id) ?? {}) };
    if (value === undefined) delete next[prop];
    else next[prop] = value;
    this.paint.set(id, next);
  }
}

const layers: Layer[] = [
  { id: 'road_major_rail', type: 'line', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#777', 'line-width': 1 } },
  { id: 'tunnel_transit_rail', type: 'line', 'source-layer': 'transportation', filter: ['match', ['get', 'class'], ['transit'], true, false], paint: { 'line-color': ['get', 'c'], 'line-opacity': 0.4 } },
  { id: 'road_minor', type: 'line', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'minor'], paint: { 'line-color': '#999' } },
  { id: 'rail-label', type: 'symbol', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'text-color': '#333' } },
  { id: 'rail-lines', type: 'line', source: 'rail', paint: { 'line-color': '#4cc3ff' } },
];

test('baseRailLayerIds matches only base-map rail line layers from the legend grouping', () => {
  assert.deepEqual(baseRailLayerIds(layers), ['road_major_rail', 'tunnel_transit_rail']);
});

test('applyBaseRailHighlight snapshots and restores only changed base rail paint', () => {
  const map = new FakeMap(layers);
  const snapshot = applyBaseRailHighlight(map);

  assert.equal(map.paint.get('road_major_rail')?.['line-color'], '#f5a623');
  assert.equal(map.paint.get('road_major_rail')?.['line-width'], 4);
  assert.equal(map.paint.get('road_major_rail')?.['line-opacity'], 0.95);
  assert.deepEqual(map.paint.get('road_minor'), { 'line-color': '#999' });
  assert.deepEqual(map.paint.get('rail-lines'), { 'line-color': '#4cc3ff' });

  restoreBaseRailHighlight(map, snapshot);

  assert.deepEqual(map.paint.get('road_major_rail'), { 'line-color': '#777', 'line-width': 1 });
  assert.deepEqual(map.paint.get('tunnel_transit_rail'), { 'line-color': ['get', 'c'], 'line-opacity': 0.4 });
  assert.deepEqual(map.paint.get('road_minor'), { 'line-color': '#999' });
});

test('restoreBaseRailHighlight does not overwrite paint changed after the highlight was applied', () => {
  const map = new FakeMap(layers);
  const snapshot = applyBaseRailHighlight(map);
  map.setPaintProperty('road_major_rail', 'line-color', '#ff00ff');

  restoreBaseRailHighlight(map, snapshot);

  assert.equal(map.paint.get('road_major_rail')?.['line-color'], '#ff00ff');
  assert.equal(map.paint.get('road_major_rail')?.['line-width'], 1);
  assert.equal(map.paint.get('road_major_rail')?.['line-opacity'], undefined);
});

test('effectiveRailOn derives rail display from rail or trains without changing the independent rail setting', () => {
  assert.equal(effectiveRailOn(false, false), false);
  assert.equal(effectiveRailOn(true, false), true);
  assert.equal(effectiveRailOn(false, true), true);
  assert.equal(effectiveRailOn(true, true), true);
});

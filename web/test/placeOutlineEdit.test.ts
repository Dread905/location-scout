import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertVertexOnNearestSegment,
  moveOutlineVertex,
  PlaceOutlineVertexMarkers,
  type MarkerLike,
} from '../src/map/placeOutlineEdit.js';

type LngLat = [number, number];
type ScreenPoint = { x: number; y: number };

const project = ([lng, lat]: LngLat): ScreenPoint => ({ x: lng * 10, y: lat * 10 });
const unproject = ({ x, y }: ScreenPoint): LngLat => [x / 10, y / 10];

test('moveOutlineVertex: moves exactly the selected vertex and preserves order', () => {
  const coords: LngLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const moved = moveOutlineVertex(coords, 2, [2, 2]);

  assert.deepEqual(moved, [[0, 0], [1, 0], [2, 2], [0, 1]]);
  assert.deepEqual(coords, [[0, 0], [1, 0], [1, 1], [0, 1]]);
});

test('insertVertexOnNearestSegment: inserts between the neighbouring vertices on a polygon edge', () => {
  const coords: LngLat[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const inserted = insertVertexOnNearestSegment(coords, 'polygon', { x: 40, y: 25 }, { project, unproject, tolerancePx: 8 });

  assert.deepEqual(inserted, {
    coords: [[0, 0], [4, 0], [4, 2.5], [4, 4], [0, 4]],
    insertIndex: 2,
  });
});

test('insertVertexOnNearestSegment: inserts after the last vertex on the closing polygon segment', () => {
  const coords: LngLat[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const inserted = insertVertexOnNearestSegment(coords, 'polygon', { x: 0, y: 15 }, { project, unproject, tolerancePx: 8 });

  assert.deepEqual(inserted, {
    coords: [[0, 0], [4, 0], [4, 4], [0, 4], [0, 1.5]],
    insertIndex: 4,
  });
});

test('insertVertexOnNearestSegment: handles line segments without closing the shape', () => {
  const coords: LngLat[] = [[0, 0], [2, 0], [4, 0]];
  const inserted = insertVertexOnNearestSegment(coords, 'line', { x: 30, y: 0 }, { project, unproject, tolerancePx: 8 });

  assert.deepEqual(inserted, {
    coords: [[0, 0], [2, 0], [3, 0], [4, 0]],
    insertIndex: 2,
  });
});

test('insertVertexOnNearestSegment: returns null for clicks away from an existing segment', () => {
  const coords: LngLat[] = [[0, 0], [4, 0], [4, 4], [0, 4]];

  assert.equal(insertVertexOnNearestSegment(coords, 'polygon', { x: 20, y: 20 }, { project, unproject, tolerancePx: 8 }), null);
});

test('PlaceOutlineVertexMarkers: creates, updates, removes handles and reports drag positions', () => {
  const made: FakeMarker[] = [];
  const map = { dragPan: { disabled: 0, enabled: 0, disable() { this.disabled += 1; }, enable() { this.enabled += 1; } } };
  const controller = new PlaceOutlineVertexMarkers({
    makeMarker: (index, at) => {
      const marker = new FakeMarker(index, at);
      made.push(marker);
      return marker;
    },
  });
  const dragged: Array<{ index: number; at: LngLat }> = [];

  controller.update(map, [[0, 0], [1, 0]], true, (index, at) => dragged.push({ index, at }));
  assert.equal(made.length, 2);
  assert.deepEqual(made.map((m) => m.addedTo), [map, map]);

  made[1].lngLat = [2, 2];
  made[1].emit('dragstart');
  made[1].emit('drag');
  made[1].emit('dragend');
  assert.deepEqual(dragged, [{ index: 1, at: [2, 2] }]);
  assert.equal(map.dragPan.disabled, 1);
  assert.equal(map.dragPan.enabled, 1);

  controller.update(map, [[5, 5]], true, (index, at) => dragged.push({ index, at }));
  assert.deepEqual(made[0].lngLat, [5, 5]);
  assert.equal(made[1].removed, true);

  controller.update(map, [[5, 5]], false, () => {});
  assert.equal(made[0].removed, true);
});

test('PlaceOutlineVertexMarkers: lets MapLibre marker start events bubble from handles', () => {
  const made: FakeMarker[] = [];
  const map = { dragPan: { disable() {}, enable() {} } };
  const controller = new PlaceOutlineVertexMarkers({
    makeMarker: (index, at) => {
      const marker = new FakeMarker(index, at);
      made.push(marker);
      return marker;
    },
  });

  controller.update(map, [[0, 0]], true, () => {});

  const element = made[0].getElement() as unknown as FakeElement;
  assert.equal(element.dispatch('mousedown'), false);
  assert.equal(element.dispatch('touchstart'), false);
});

class FakeMarker implements MarkerLike<unknown> {
  lngLat: LngLat;
  addedTo: unknown = null;
  removed = false;
  private handlers = new Map<string, Array<() => void>>();
  private element = new FakeElement() as unknown as HTMLElement;

  constructor(readonly index: number, at: LngLat) {
    this.lngLat = at;
  }

  setLngLat(at: LngLat): this {
    this.lngLat = at;
    return this;
  }

  getLngLat(): { lng: number; lat: number } {
    return { lng: this.lngLat[0], lat: this.lngLat[1] };
  }

  addTo(map: unknown): this {
    this.addedTo = map;
    return this;
  }

  remove(): void {
    this.removed = true;
  }

  on(type: string, handler: () => void): this {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
    return this;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  emit(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler();
  }
}

class FakeElement {
  private listeners = new Map<string, EventListener[]>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): boolean {
    let stopped = false;
    const event = {
      stopPropagation: () => { stopped = true; },
    } as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return stopped;
  }
}

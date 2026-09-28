import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachKeyboardNudge,
  type Coordinate,
  createMapProjectionAdapter,
  createSunAnchorElement,
  handleSunAnchorPlacementClick,
  type MapProjectionAdapter,
  nudgeAnchor,
  resolveDisplayOrigin,
  type ScreenPixel,
  SUN_ANCHOR_SHIFT_STEP_PX,
  SUN_ANCHOR_STEP_PX,
  SunAnchorController,
} from '../src/map/sunAnchor.js';

test('resolveDisplayOrigin: anchor wins over draft, selected spot, and viewport centre', () => {
  const anchor = { lat: 10, lng: 20 };
  const draft = { lat: 30, lng: 40 };
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: anchor,
    spotDraft: draft,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, anchor);
});

test('resolveDisplayOrigin: draft wins over selected spot and viewport centre when no anchor exists', () => {
  const draft = { lat: 30, lng: 40 };
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: draft,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, draft);
});

test('resolveDisplayOrigin: selected spot wins over viewport centre when no anchor or draft exists', () => {
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: null,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, selected);
});

test('resolveDisplayOrigin: viewport centre is the final fallback', () => {
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: null,
    selectedSpot: null,
    viewportCentre: centre,
  });

  assert.deepEqual(result, centre);
});

test('nudgeAnchor: uses injected projection adapter project and unproject operations', () => {
  let projectCalledWith: Coordinate | null = null;
  let unprojectCalledWith: ScreenPixel | null = null;

  const spyAdapter: MapProjectionAdapter = {
    project(coord) {
      projectCalledWith = coord;
      return { x: 200, y: 300 };
    },
    unproject(pixel) {
      unprojectCalledWith = pixel;
      return { lat: 12.34, lng: 56.78 };
    },
  };

  const current = { lat: 10, lng: 20 };
  const result = nudgeAnchor(current, 'ArrowUp', spyAdapter);

  assert.deepEqual(projectCalledWith, current, 'project must be called with current coordinate');
  assert.deepEqual(unprojectCalledWith, { x: 200, y: 300 - SUN_ANCHOR_STEP_PX }, 'unproject must be called with 1px adjusted screen pixel');
  assert.deepEqual(result, { lat: 12.34, lng: 56.78 }, 'result must be the coordinate returned from unproject');
});

test('nudgeAnchor: direction is correct in screen pixel coordinates (Up=-Y, Down=+Y, Left=-X, Right=+X)', () => {
  const unprojectCalls: ScreenPixel[] = [];
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => {
      unprojectCalls.push(pixel);
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: 0, lng: 0 };

  // Up: screen Y decreases
  nudgeAnchor(current, 'ArrowUp', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 500, y: 499 });

  // Down: screen Y increases
  nudgeAnchor(current, 'ArrowDown', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 500, y: 501 });

  // Left: screen X decreases
  nudgeAnchor(current, 'ArrowLeft', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 499, y: 500 });

  // Right: screen X increases
  nudgeAnchor(current, 'ArrowRight', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 501, y: 500 });
});

test('nudgeAnchor: Shift modifier uses 10px step while default nudge uses 1px step', () => {
  const unprojectCalls: ScreenPixel[] = [];
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 100, y: 100 }),
    unproject: (pixel) => {
      unprojectCalls.push(pixel);
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: 0, lng: 0 };

  // Without Shift: 1px
  nudgeAnchor(current, 'ArrowUp', adapter, false);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 - SUN_ANCHOR_STEP_PX });

  // With Shift (boolean true): 10px
  nudgeAnchor(current, 'ArrowUp', adapter, true);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 - SUN_ANCHOR_SHIFT_STEP_PX });

  // With Shift in options object: 10px
  nudgeAnchor(current, 'ArrowRight', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100 + SUN_ANCHOR_SHIFT_STEP_PX, y: 100 });

  // With Shift in options object for ArrowDown and ArrowLeft
  nudgeAnchor(current, 'ArrowDown', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 + SUN_ANCHOR_SHIFT_STEP_PX });

  nudgeAnchor(current, 'ArrowLeft', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100 - SUN_ANCHOR_SHIFT_STEP_PX, y: 100 });
});

test('nudgeAnchor: geographic movement adapts to projection scale and zoom level', () => {
  // Zoom 10 simulation: 1px = 0.001 degrees
  const lowZoomAdapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => ({
      lat: (500 - pixel.y) * 0.001,
      lng: (pixel.x - 500) * 0.001,
    }),
  };

  // Zoom 15 simulation: 1px = 0.00003 degrees (~33x higher zoom)
  const highZoomAdapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => ({
      lat: (500 - pixel.y) * 0.00003,
      lng: (pixel.x - 500) * 0.00003,
    }),
  };

  const current = { lat: 0, lng: 0 };
  const lowZoomResult = nudgeAnchor(current, 'ArrowUp', lowZoomAdapter);
  const highZoomResult = nudgeAnchor(current, 'ArrowUp', highZoomAdapter);

  // Both moved by 1 screen pixel, but geographic lat change scales with the zoom adapter
  assert.equal(lowZoomResult.lat, 0.001);
  assert.equal(highZoomResult.lat, 0.00003);
  assert.ok(
    highZoomResult.lat < lowZoomResult.lat,
    'high zoom geographic movement per pixel must be smaller than low zoom',
  );
});

test('nudgeAnchor: non-arrow key does not move anchor and does not invoke unproject', () => {
  let unprojectInvoked = false;
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 100, y: 100 }),
    unproject: (pixel) => {
      unprojectInvoked = true;
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: -33.419, lng: 149.577 };
  const enterResult = nudgeAnchor(current, 'Enter', adapter);
  assert.deepEqual(enterResult, current);
  assert.equal(unprojectInvoked, false);

  const tabResult = nudgeAnchor(current, 'Tab', adapter);
  assert.deepEqual(tabResult, current);
  assert.equal(unprojectInvoked, false);
});

test('handleSunAnchorPlacementClick: consumes click and exits placement mode when mode is anchor', () => {
  const click = handleSunAnchorPlacementClick('anchor', { lat: -33.42, lng: 149.58 });
  assert.equal(click.consumed, true);
  assert.deepEqual(click.newAnchor, { lat: -33.42, lng: 149.58 });
  assert.equal(click.nextMode, 'browse');
});

test('handleSunAnchorPlacementClick: does not consume click when mode is browse or pick-spot', () => {
  const browseClick = handleSunAnchorPlacementClick('browse', { lat: -33.42, lng: 149.58 });
  assert.equal(browseClick.consumed, false);
  assert.equal(browseClick.newAnchor, undefined);

  const spotClick = handleSunAnchorPlacementClick('pick-spot', { lat: -33.42, lng: 149.58 });
  assert.equal(spotClick.consumed, false);
});

test('attachKeyboardNudge: handles 1px arrow keys, 10px with Shift, and stops propagation', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const mockEl = {
    addEventListener: (event: string, handler: (e: any) => void) => { listeners[event] = handler; },
    removeEventListener: (event: string, _handler: (e: any) => void) => { delete listeners[event]; },
  };

  let current = { lat: 10, lng: 20 };
  let moved: Coordinate | null = null;
  const mockProjection: MapProjectionAdapter = {
    project: (_c) => ({ x: 100, y: 100 }),
    unproject: (p) => ({ lat: p.y, lng: p.x }),
  };

  const teardown = attachKeyboardNudge(
    mockEl,
    () => current,
    (next) => { moved = next; },
    mockProjection,
  );

  // 1. ArrowUp without Shift -> 1px step (y = 100 - 1 = 99)
  let prevented = false;
  let stopped = false;
  listeners['keydown']({
    key: 'ArrowUp',
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true, 'preventDefault must be called');
  assert.equal(stopped, true, 'stopPropagation must be called so map does not pan');
  assert.deepEqual(moved, { lat: 99, lng: 100 });

  // 2. ArrowRight with Shift -> 10px step (x = 100 + 10 = 110)
  prevented = false;
  stopped = false;
  moved = null;
  listeners['keydown']({
    key: 'ArrowRight',
    shiftKey: true,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(moved, { lat: 100, lng: 110 });

  // 3. Non-arrow key does not prevent, stop, or move
  prevented = false;
  stopped = false;
  moved = null;
  listeners['keydown']({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, false);
  assert.equal(stopped, false);
  assert.equal(moved, null);

  teardown();
  assert.equal(listeners['keydown'], undefined);
});

test('createMapProjectionAdapter: delegates project and unproject to MapLibre map', () => {
  let projectArg: any = null;
  let unprojectArg: any = null;
  const mockMap = {
    project: (ll: any) => {
      projectArg = ll;
      return { x: 42, y: 84 };
    },
    unproject: (pt: any) => {
      unprojectArg = pt;
      return { lat: -33.5, lng: 150.1 };
    },
  };

  const adapter = createMapProjectionAdapter(mockMap as any);
  const pixel = adapter.project({ lat: -33.4, lng: 149.5 });
  assert.deepEqual(pixel, { x: 42, y: 84 });
  assert.deepEqual(projectArg, [149.5, -33.4]);

  const coord = adapter.unproject({ x: 10, y: 20 });
  assert.deepEqual(coord, { lat: -33.5, lng: 150.1 });
  assert.deepEqual(unprojectArg, [10, 20]);
});

test('SunAnchorController: manages marker lifecycle through adapter and forwards projection', () => {
  let createdOptions: any = null;
  let setLngLatCalledWith: any = null;
  let removed = false;

  const mockHandle = {
    setLngLat: (c: any) => { setLngLatCalledWith = c; },
    remove: () => { removed = true; },
  };

  const mockAdapter = {
    create: (options: any) => {
      createdOptions = options;
      return mockHandle;
    },
  };

  const mockProjection: MapProjectionAdapter = {
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lat: 0, lng: 0 }),
  };

  const controller = new SunAnchorController(mockAdapter as any);
  const mockMap = {} as any;
  let anchor: { lat: number; lng: number } | null = { lat: -33.419, lng: 149.577 };
  const onMove = (_c: any) => {};

  // 1. Initial sync with map and anchor creates marker and forwards projection
  controller.sync(mockMap, anchor, onMove, mockProjection);
  assert.ok(createdOptions);
  assert.equal(createdOptions.map, mockMap);
  assert.deepEqual(createdOptions.coord, anchor);
  assert.equal(createdOptions.projection, mockProjection);
  assert.equal(controller.getHandle(), mockHandle);

  // 2. Sync with updated coordinates calls setLngLat
  anchor = { lat: -33.42, lng: 149.58 };
  controller.sync(mockMap, anchor, onMove);
  assert.deepEqual(setLngLatCalledWith, anchor);
  assert.equal(removed, false);

  // 3. Sync with null anchor removes marker and clears handle
  controller.sync(mockMap, null, onMove);
  assert.equal(removed, true);
  assert.equal(controller.getHandle(), null);

  // 4. Destroy cleans up if handle was active
  removed = false;
  controller.sync(mockMap, { lat: 1, lng: 2 }, onMove);
  assert.ok(controller.getHandle());
  controller.destroy();
  assert.equal(removed, true);
  assert.equal(controller.getHandle(), null);
});

test('createSunAnchorElement: configures accessible role, tabindex, label, and class with Shift modifier instructions', () => {
  const attrs: Record<string, string> = {};
  const mockDoc = {
    createElement: (tag: string) => ({
      tagName: tag,
      className: '',
      title: '',
      innerHTML: '',
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      getAttribute: (name: string) => attrs[name],
    }),
  };

  const origDoc = (globalThis as any).document;
  (globalThis as any).document = mockDoc;
  try {
    const el = createSunAnchorElement() as any;
    assert.equal(el.className, 'sun-anchor-crosshair');
    assert.equal(attrs['role'], 'button');
    assert.equal(attrs['tabindex'], '0');
    assert.equal(attrs['aria-label'], 'Sun anchor crosshair');
    assert.ok(attrs['aria-description']?.includes('arrow keys'));
    assert.ok(attrs['aria-description']?.includes('Shift'));
    assert.ok(attrs['aria-description']?.includes('10px'));
    assert.ok(el.title?.includes('arrow keys'));
    assert.ok(el.title?.includes('Shift'));
    assert.ok(el.title?.includes('10px'));
    assert.ok(el.innerHTML.includes('svg'));
  } finally {
    (globalThis as any).document = origDoc;
  }
});

test('sun anchor workflow: placement, selection preservation, origin precedence, and clear follow-camera', () => {
  // Simulate MapPage state model
  let mode: 'browse' | 'pick-spot' | 'draw' | 'anchor' = 'browse';
  let sunAnchor: { lat: number; lng: number } | null = null;
  let selectedSpot: { lat: number; lng: number } | null = null;
  let spotDraft: { lat: number; lng: number } | null = null;
  let centre = { lat: -33.419, lng: 149.577 };

  const getOrigin = () => resolveDisplayOrigin({ sunAnchor, spotDraft, selectedSpot, viewportCentre: centre });

  // 1. Initially, display origin follows viewport centre
  assert.deepEqual(getOrigin(), centre);

  // 2. Select a spot -> origin follows selected spot
  selectedSpot = { lat: -33.5, lng: 150.0 };
  assert.deepEqual(getOrigin(), selectedSpot);

  // 3. Enter placement mode
  mode = (mode as string) === 'anchor' ? 'browse' : 'anchor';
  assert.equal(mode, 'anchor');



  // 4. Map click in placement mode
  const clickCoord = { lat: -33.45, lng: 149.65 };
  const clickResult = handleSunAnchorPlacementClick(mode, clickCoord);
  assert.equal(clickResult.consumed, true);
  if (clickResult.consumed && clickResult.newAnchor) {
    sunAnchor = clickResult.newAnchor;
    mode = clickResult.nextMode ?? 'browse';
  }
  assert.equal(mode, 'browse');
  assert.deepEqual(sunAnchor, clickCoord);

  // 5. Selected spot remains unchanged!
  assert.deepEqual(selectedSpot, { lat: -33.5, lng: 150.0 });

  // 6. Display origin is now the sun anchor (anchor overrides selected spot)
  assert.deepEqual(getOrigin(), sunAnchor);

  // 7. Panning camera changes viewport centre, but display origin stays at anchor
  centre = { lat: -33.6, lng: 150.2 };
  assert.deepEqual(getOrigin(), sunAnchor);

  // 8. Editing a spot: spotDraft exists, but anchor still wins over draft
  spotDraft = { lat: -33.48, lng: 149.6 };
  assert.deepEqual(getOrigin(), sunAnchor);

  // 9. Dragging the anchor updates sunAnchor and display origin
  const draggedCoord = { lat: -33.46, lng: 149.66 };
  sunAnchor = draggedCoord;
  assert.deepEqual(getOrigin(), draggedCoord);

  // 10. Clear anchor / follow camera restores draft (or selected spot)
  sunAnchor = null;
  assert.deepEqual(getOrigin(), spotDraft);

  // Cancel edit -> restores selected spot
  spotDraft = null;
  assert.deepEqual(getOrigin(), selectedSpot);

  // Deselect spot -> falls back to current viewport centre
  selectedSpot = null;
  assert.deepEqual(getOrigin(), centre);
});

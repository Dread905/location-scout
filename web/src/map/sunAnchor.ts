import { Marker, type Map as MlMap } from 'maplibre-gl';

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface DisplayOriginParams {
  sunAnchor?: Coordinate | null;
  spotDraft?: Coordinate | null;
  selectedSpot?: Coordinate | null;
  viewportCentre: Coordinate;
}

/**
 * Resolves the display origin for the sun rays and TimeBar.
 * Precedence:
 * 1. Sun anchor
 * 2. Editing spot draft
 * 3. Selected saved spot
 * 4. Viewport centre
 */
export function resolveDisplayOrigin(params: DisplayOriginParams): Coordinate {
  if (params.sunAnchor) return params.sunAnchor;
  if (params.spotDraft) return params.spotDraft;
  if (params.selectedSpot) return params.selectedSpot;
  return params.viewportCentre;
}

export interface ScreenPixel {
  x: number;
  y: number;
}

export interface MapProjectionAdapter {
  project(coord: Coordinate): ScreenPixel;
  unproject(pixel: ScreenPixel): Coordinate;
}

export const SUN_ANCHOR_STEP_PX = 1;
export const SUN_ANCHOR_SHIFT_STEP_PX = 10;

export function createMapProjectionAdapter(map: MlMap): MapProjectionAdapter {
  return {
    project(coord: Coordinate): ScreenPixel {
      const pt = map.project([coord.lng, coord.lat]);
      return { x: pt.x, y: pt.y };
    },
    unproject(pixel: ScreenPixel): Coordinate {
      const ll = map.unproject([pixel.x, pixel.y]);
      return { lat: ll.lat, lng: ll.lng };
    },
  };
}

const ARROW_OFFSETS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

/**
 * Pure helper to nudge a coordinate using keyboard arrow keys.
 * Uses injected projection adapter to convert coordinate to screen pixels,
 * applies 1px (or 10px with Shift) in screen space, and unprojects back to coordinates.
 * Invalid or non-arrow keys leave the coordinate unchanged.
 */
export function nudgeAnchor(
  current: Coordinate,
  key: string,
  projection: MapProjectionAdapter,
  options?: { shiftKey?: boolean; stepPx?: number } | boolean,
): Coordinate {
  const offset = ARROW_OFFSETS[key];
  if (!offset) {
    return current;
  }

  const shiftKey = typeof options === 'boolean' ? options : options?.shiftKey ?? false;
  const stepPx = typeof options === 'object' && options?.stepPx != null
    ? options.stepPx
    : shiftKey
    ? SUN_ANCHOR_SHIFT_STEP_PX
    : SUN_ANCHOR_STEP_PX;

  const pixel = projection.project(current);
  const nextPixel: ScreenPixel = {
    x: pixel.x + offset.dx * stepPx,
    y: pixel.y + offset.dy * stepPx,
  };

  return projection.unproject(nextPixel);
}

/**
 * Placement click handler: consumes click if currently in anchor placement mode,
 * returns the coordinate for the new anchor and transitions mode back to 'browse'.
 */
export function handleSunAnchorPlacementClick(
  mode: string,
  coord: Coordinate,
): { consumed: boolean; newAnchor?: Coordinate; nextMode?: 'browse' } {
  if (mode === 'anchor') {
    return { consumed: true, newAnchor: coord, nextMode: 'browse' };
  }
  return { consumed: false };
}

export interface EventTargetLike {
  addEventListener(event: string, handler: (e: any) => void): void;
  removeEventListener(event: string, handler: (e: any) => void): void;
}

/**
 * Attaches keyboard listeners to the anchor DOM element for arrow-key nudging.
 * Prevents default and stops propagation so the MapLibre map does not pan.
 */
export function attachKeyboardNudge(
  target: EventTargetLike,
  getCoord: () => Coordinate,
  onMove: (coord: Coordinate) => void,
  projection: MapProjectionAdapter | (() => MapProjectionAdapter),
): () => void {
  const onKeyDown = (e: {
    key: string;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const current = getCoord();
      const proj = typeof projection === 'function' ? projection() : projection;
      const next = nudgeAnchor(current, e.key, proj, e.shiftKey ?? false);
      onMove(next);
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}

export interface SunAnchorMarkerHandle {
  setLngLat(coord: Coordinate): void;
  remove(): void;
  getElement?(): HTMLElement;
}

export interface SunAnchorMarkerAdapter {
  create(options: {
    map: MlMap;
    coord: Coordinate;
    onMove: (coord: Coordinate) => void;
    projection?: MapProjectionAdapter;
  }): SunAnchorMarkerHandle;
}

export function createSunAnchorElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sun-anchor-crosshair';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', 'Sun anchor crosshair');
  el.setAttribute('aria-description', 'Use arrow keys to nudge position (hold Shift for 10px), or drag to move.');
  el.title = 'Sun anchor crosshair (drag or use arrow keys to move, Shift for 10px)';
  el.innerHTML = `
    <svg class="sun-anchor-crosshair__icon" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
      <circle class="sun-anchor-crosshair__ring" cx="16" cy="16" r="9" />
      <circle class="sun-anchor-crosshair__dot" cx="16" cy="16" r="2.5" />
      <line class="sun-anchor-crosshair__line" x1="16" y1="2" x2="16" y2="7" />
      <line class="sun-anchor-crosshair__line" x1="16" y1="25" x2="16" y2="30" />
      <line class="sun-anchor-crosshair__line" x1="2" y1="16" x2="7" y2="16" />
      <line class="sun-anchor-crosshair__line" x1="25" y1="16" x2="30" y2="16" />
    </svg>
  `;
  return el;
}

export const defaultSunAnchorAdapter: SunAnchorMarkerAdapter = {
  create({ map, coord, onMove, projection }) {
    const el = createSunAnchorElement();
    const marker = new Marker({ element: el, draggable: true })
      .setLngLat([coord.lng, coord.lat])
      .addTo(map);

    let isDragging = false;
    const currentCoord = { lat: coord.lat, lng: coord.lng };

    const onDragStart = () => {
      isDragging = true;
    };
    const onDrag = () => {
      const ll = marker.getLngLat();
      currentCoord.lat = ll.lat;
      currentCoord.lng = ll.lng;
      onMove({ lat: ll.lat, lng: ll.lng });
    };
    const onDragEnd = () => {
      isDragging = false;
    };

    marker.on('dragstart', onDragStart);
    marker.on('drag', onDrag);
    marker.on('dragend', onDragEnd);

    const proj = projection ?? createMapProjectionAdapter(map);

    const detachKeyboard = attachKeyboardNudge(
      el,
      () => currentCoord,
      (next) => {
        currentCoord.lat = next.lat;
        currentCoord.lng = next.lng;
        marker.setLngLat([next.lng, next.lat]);
        onMove(next);
      },
      proj,
    );

    return {
      setLngLat(next: Coordinate) {
        currentCoord.lat = next.lat;
        currentCoord.lng = next.lng;
        if (!isDragging) {
          marker.setLngLat([next.lng, next.lat]);
        }
      },
      remove() {
        detachKeyboard();
        marker.off('dragstart', onDragStart);
        marker.off('drag', onDrag);
        marker.off('dragend', onDragEnd);
        marker.remove();
      },
      getElement() {
        return el;
      },
    };
  },
};

/**
 * Controller to manage the lifecycle of the sun anchor marker on the map.
 * Reuses the adapter pattern to enable isolated unit testing without a live map.
 */
export class SunAnchorController {
  private handle: SunAnchorMarkerHandle | null = null;
  private adapter: SunAnchorMarkerAdapter;

  constructor(adapter: SunAnchorMarkerAdapter = defaultSunAnchorAdapter) {
    this.adapter = adapter;
  }

  sync(
    map: MlMap | null,
    anchor: Coordinate | null,
    onMove: (coord: Coordinate) => void,
    projection?: MapProjectionAdapter,
  ): void {
    if (!map || !anchor) {
      this.destroy();
      return;
    }
    if (!this.handle) {
      this.handle = this.adapter.create({ map, coord: anchor, onMove, projection });
    } else {
      this.handle.setLngLat(anchor);
    }
  }

  destroy(): void {
    if (this.handle) {
      this.handle.remove();
      this.handle = null;
    }
  }

  getHandle(): SunAnchorMarkerHandle | null {
    return this.handle;
  }
}

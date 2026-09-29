type LngLat = [number, number];
type ScreenPoint = { x: number; y: number };

export type OutlineKind = 'polygon' | 'line';

export interface SegmentProjection {
  project: (at: LngLat) => ScreenPoint;
  unproject: (point: ScreenPoint) => LngLat;
  tolerancePx: number;
}

export function moveOutlineVertex(coords: LngLat[], index: number, at: LngLat): LngLat[] {
  if (index < 0 || index >= coords.length) return coords.slice();
  return coords.map((coord, i) => (i === index ? at : coord));
}

export function insertVertexOnNearestSegment(
  coords: LngLat[],
  kind: OutlineKind,
  point: ScreenPoint,
  projection: SegmentProjection,
): { coords: LngLat[]; insertIndex: number } | null {
  const segmentCount = kind === 'polygon' && coords.length >= 3 ? coords.length : Math.max(0, coords.length - 1);
  if (!segmentCount) return null;

  let best: { distance: number; point: ScreenPoint; insertIndex: number } | null = null;
  for (let i = 0; i < segmentCount; i++) {
    const a = projection.project(coords[i]);
    const b = projection.project(coords[(i + 1) % coords.length]);
    const projected = closestPointOnSegment(point, a, b);
    const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
    if (!best || distance < best.distance) best = { distance, point: projected, insertIndex: i + 1 };
  }

  if (!best || best.distance > projection.tolerancePx) return null;
  const next = coords.slice();
  next.splice(best.insertIndex, 0, projection.unproject(best.point));
  return { coords: next, insertIndex: best.insertIndex };
}

function closestPointOnSegment(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

export interface MarkerLike<TMap> {
  setLngLat(at: LngLat): this;
  getLngLat(): { lng: number; lat: number };
  addTo(map: TMap): this;
  remove(): void;
  on(type: 'dragstart' | 'drag' | 'dragend' | string, handler: () => void): unknown;
  getElement(): HTMLElement;
}

type DragPan = { disable: () => void; enable: () => void };
type HandleMap = { dragPan?: DragPan };

export class PlaceOutlineVertexMarkers<TMap extends HandleMap = HandleMap> {
  private markers: MarkerLike<TMap>[] = [];

  constructor(private readonly options: {
    makeMarker: (index: number, at: LngLat) => MarkerLike<TMap>;
  }) {}

  update(map: TMap | null, coords: LngLat[], active: boolean, onDrag: (index: number, at: LngLat) => void): void {
    if (!map || !active || coords.length === 0) {
      this.clear();
      return;
    }

    while (this.markers.length > coords.length) this.markers.pop()!.remove();

    coords.forEach((coord, index) => {
      const marker = this.markers[index] ?? this.addMarker(map, index, coord, onDrag);
      marker.setLngLat(coord);
    });
  }

  clear(): void {
    for (const marker of this.markers) marker.remove();
    this.markers = [];
  }

  private addMarker(map: TMap, index: number, at: LngLat, onDrag: (index: number, at: LngLat) => void): MarkerLike<TMap> {
    const marker = this.options.makeMarker(index, at).addTo(map);
    marker.on('dragstart', () => map.dragPan?.disable());
    marker.on('drag', () => {
      const ll = marker.getLngLat();
      onDrag(index, [ll.lng, ll.lat]);
    });
    marker.on('dragend', () => map.dragPan?.enable());
    this.markers[index] = marker;
    return marker;
  }
}

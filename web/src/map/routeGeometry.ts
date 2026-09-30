/**
 * Route geometry helpers — pure functions for the Rolling Routes feature.
 *
 * A route is a sequence of [lng, lat] vertices.
 * - sprint: straight legs joining consecutive vertices.
 * - circuit: same, plus a closing leg from the last vertex back to the first.
 *
 * Vertex manipulation (click-to-add, drag-to-move, click-segment-to-insert,
 * undo, clear) is handled by reusing PlaceOutlineVertexMarkers with kind='line'
 * from placeOutlineEdit.ts — see RouteEditor in the UI layer.
 */

export type RouteType = 'sprint' | 'circuit';

/**
 * Build the ordered list of directed segments for a route.
 *
 * Each segment is [from, to] as [lng, lat] pairs. The closing leg (last→first)
 * is appended last for circuits. Requires ≥ 2 vertices to produce any segments.
 */
export function buildRouteSegments(
  vertices: [number, number][],
  type: RouteType,
): [[number, number], [number, number]][] {
  if (vertices.length < 2) return [];
  const segs: [[number, number], [number, number]][] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    segs.push([vertices[i], vertices[i + 1]]);
  }
  if (type === 'circuit') {
    segs.push([vertices[vertices.length - 1], vertices[0]]);
  }
  return segs;
}

/**
 * Resolve the planning anchor for a route.
 *
 * The anchor is used as the location for sun/weather/trains/planes lookups in
 * Plan Shoot. Priority: staging location → first vertex → null.
 */
export function routePlanAnchor(
  vertices: [number, number][],
  staging: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (staging) return { lat: staging.lat, lng: staging.lng };
  if (vertices.length > 0) {
    const [lng, lat] = vertices[0];
    return { lat, lng };
  }
  return null;
}

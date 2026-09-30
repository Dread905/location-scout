import type { Visibility } from './auth.js';

export type RouteType = 'sprint' | 'circuit';
export type RouteVertex = [number, number];
export interface RouteStaging { lat: number; lng: number }

export interface RouteRow {
  id: string;
  owner_id: string;
  name: string;
  notes: string;
  access: string;
  type: RouteType;
  vertices: string;
  staging: string | null;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
}

export function isRouteType(v: unknown): v is RouteType {
  return v === 'sprint' || v === 'circuit';
}

export function parseRouteVertices(value: unknown): RouteVertex[] {
  if (!Array.isArray(value)) throw new Error('vertices must be an array');
  return value.map((vertex, index): RouteVertex => {
    if (!Array.isArray(vertex) || vertex.length !== 2 || !isFiniteNumber(vertex[0]) || !isFiniteNumber(vertex[1])) {
      throw new Error(`vertex ${index + 1} must be [lng, lat] numbers`);
    }
    const [lng, lat] = vertex;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new Error(`vertex ${index + 1} is outside valid lng/lat bounds`);
    }
    return [lng, lat];
  });
}

export function parseRouteStaging(value: unknown): RouteStaging | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new Error('staging must be null or { lat, lng }');
  const staging = value as Record<string, unknown>;
  if (!isFiniteNumber(staging.lat) || !isFiniteNumber(staging.lng)) throw new Error('staging must be null or { lat, lng }');
  const lat = staging.lat;
  const lng = staging.lng;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('staging is outside valid lat/lng bounds');
  return { lat, lng };
}

export function routeJson(r: RouteRow) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    notes: r.notes,
    access: r.access,
    type: r.type,
    vertices: JSON.parse(r.vertices) as RouteVertex[],
    staging: r.staging ? JSON.parse(r.staging) as RouteStaging : null,
    visibility: r.visibility,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

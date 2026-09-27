/** Pure helpers for the "Nearby" list: distance sorting and row formatting for planes and trains. No MapLibre, no DOM. */
import { haversineKm } from './geo.js';
import { altitudeM } from './planes3d.js';

export const KNOTS_TO_KMH = 1.852;
export const NEARBY_CAP = 15;

export interface PlaneLike { hex: string; flight?: string | null; lat: number; lon: number; track: number | null; gs: number | null; alt_baro: number | 'ground' | null; t?: string | null }
export interface TrainLike { tripId: string; route: string; headsign: string; lat: number; lng: number; status: 'live' | 'scheduled' | string; delaySec: number }

export interface PlaneRow { id: string; lat: number; lng: number; name: string; type: string; alt: string; speed: string; distKm: number; dist: string; track: number | null }
export interface TrainRow { id: string; lat: number; lng: number; title: string; live: boolean; delay: string; distKm: number; dist: string }

export function formatDistance(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function formatAltitude(altBaro: number | 'ground' | null | undefined): string {
  const m = altitudeM(altBaro);
  if (m == null) return '–';
  if (m <= 0) return 'ground';
  return `${(Math.round(m / 10) * 10).toLocaleString('en-US')} m`;
}

export function formatSpeed(gsKnots: number | null | undefined): string {
  if (typeof gsKnots !== 'number' || !Number.isFinite(gsKnots)) return '–';
  return `${Math.round(gsKnots * KNOTS_TO_KMH)} km/h`;
}

export function formatDelay(sec: number): string {
  const min = Math.round(sec / 60);
  if (min === 0) return 'on time';
  return min > 0 ? `+${min} min` : `${min} min`;
}

/** Stable sort by distance, then id, so rows don't jitter between equal distances. */
function byDistance<T extends { distKm: number; id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.distKm - b.distKm || a.id.localeCompare(b.id));
}

export function planeRows(planes: PlaneLike[], centre: { lat: number; lng: number }): PlaneRow[] {
  return byDistance(planes.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => {
    const distKm = haversineKm(centre.lat, centre.lng, p.lat, p.lon);
    return {
      id: p.hex, lat: p.lat, lng: p.lon, name: (p.flight ?? '').trim() || p.hex.toUpperCase(), type: (p.t ?? '').trim(),
      alt: formatAltitude(p.alt_baro), speed: formatSpeed(p.gs), distKm, dist: formatDistance(distKm), track: p.track,
    };
  }));
}

export function trainRows(trains: TrainLike[], centre: { lat: number; lng: number }): TrainRow[] {
  return byDistance(trains.filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng)).map((t) => {
    const distKm = haversineKm(centre.lat, centre.lng, t.lat, t.lng);
    const route = t.route || 'Train';
    return {
      id: t.tripId, lat: t.lat, lng: t.lng, title: t.headsign ? `${route} → ${t.headsign}` : route,
      live: t.status === 'live', delay: formatDelay(t.delaySec ?? 0), distKm, dist: formatDistance(distKm),
    };
  }));
}

/** The rows to show: all when expanded, else the first `cap`. */
export function capRows<T>(rows: T[], expanded: boolean, cap = NEARBY_CAP): T[] {
  return expanded ? rows : rows.slice(0, cap);
}

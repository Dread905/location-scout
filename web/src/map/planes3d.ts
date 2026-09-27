/** Pure geometry for 3D planes: altitude, ground shadow, label, pitch blend and the marker mesh. No MapLibre, no DOM. */
import { shadowOffset } from './shadows.js';

export const FT_TO_M = 0.3048;
/** Cap on a plane's ground shadow distance, metres. */
export const MAX_PLANE_SHADOW_M = 3000;
/** Pitch (degrees) where the 3D planes start fading in, and where they are fully in. */
export const PITCH_3D_START = 15;
export const PITCH_3D_FULL = 35;

/** Barometric altitude (feet, or adsb 'ground') to metres; null when unknown. */
export function altitudeM(altBaro: number | 'ground' | null | undefined): number | null {
  if (altBaro === 'ground') return 0;
  if (typeof altBaro !== 'number' || !Number.isFinite(altBaro)) return null;
  return Math.max(0, altBaro * FT_TO_M);
}

/**
 * Height to draw the plane at, in the map's (exaggerated) terrain space: the ground as rendered plus the plane's
 * true height above the real ground (alt_baro is above sea level; the rendered ground is exaggerated).
 */
export function renderAltitude(altM: number, groundRenderedM: number, exaggeration = 1): number {
  const groundTrue = exaggeration > 0 ? groundRenderedM / exaggeration : groundRenderedM;
  return groundRenderedM + Math.max(0, altM - groundTrue);
}

/** Ground point of a plane's shadow, [lng, lat]; null when the sun is at or below the horizon. */
export function planeShadowPos(lng: number, lat: number, heightM: number, sun: { azimuth: number; altitude: number }): [number, number] | null {
  if (sun.altitude <= 0) return null;
  const len = Math.min(MAX_PLANE_SHADOW_M, Math.max(0, heightM) / Math.tan((sun.altitude * Math.PI) / 180));
  const [dx, dy] = shadowOffset(len, sun.azimuth, lat);
  return [lng + dx, lat + dy];
}

/** "QFA123 · 9,400 m" (callsign, else hex; altitude rounded to 100 m, "ground" at 0). */
export function planeLabel(callsign: string, hex: string, altM: number | null): string {
  const name = callsign.trim() || hex.toUpperCase();
  if (altM == null) return name;
  if (altM <= 0) return `${name} · ground`;
  return `${name} · ${(Math.round(altM / 100) * 100).toLocaleString('en-US')} m`;
}

/** 0 at flat view, 1 when pitched enough for 3D; smoothstep between. */
export function pitchBlend(pitch: number): number {
  const t = Math.min(1, Math.max(0, (pitch - PITCH_3D_START) / (PITCH_3D_FULL - PITCH_3D_START)));
  return t * t * (3 - 2 * t);
}

/** Rotate a local (east, north) point clockwise by a compass track so the nose (0, 1) points along it. */
export function rotateByTrack(x: number, y: number, trackDeg: number): [number, number] {
  const t = (trackDeg * Math.PI) / 180;
  return [x * Math.cos(t) + y * Math.sin(t), -x * Math.sin(t) + y * Math.cos(t)];
}

/** Low-poly plane, triangles in local units (x east, y north = nose, z up), span 2 (wingtip to wingtip). */
export const PLANE_MESH: [number, number, number][] = [
  // fuselage + wings (flat arrow)
  [0, 1, 0], [-1, -0.25, 0], [0, 0.05, 0],
  [0, 1, 0], [0, 0.05, 0], [1, -0.25, 0],
  [0, 0.3, 0], [-0.12, -0.9, 0], [0.12, -0.9, 0],
  // tailplane
  [0, -0.55, 0], [-0.4, -0.95, 0], [0.4, -0.95, 0],
  // fin
  [0, -0.5, 0], [0, -0.95, 0], [0, -0.95, 0.45],
];

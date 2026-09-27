/** Typed client for every server/src/index.ts endpoint. */

export type Role = 'admin' | 'contributor';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface User {
  id: string;
  username: string;
  role: Role;
  created_at: string;
}

export interface AuthStatus {
  mode: 'private' | 'public';
  needsSetup: boolean;
  authed: boolean;
  user: User | null;
  allowSignup: boolean;
}

export type Phase = 'sunrise' | 'golden_am' | 'day' | 'golden_pm' | 'sunset' | 'blue' | 'night' | 'astro';
export type Days = 'any' | 'weekday' | 'weekend';

export interface GoodTimes {
  phases: Phase[];
  months: number[];
  days: Days;
  conditions: string[];
  eventKeywords: string[];
  avoid: string;
  notes: string;
}

export interface Place {
  id: string;
  ownerId: string;
  name: string;
  notes: string;
  access: string;
  lat: number;
  lng: number;
  geom: unknown;
  visibility: Visibility;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface Spot {
  id: string;
  placeId: string | null;
  ownerId: string;
  name: string;
  notes: string;
  lat: number;
  lng: number;
  tags: string[];
  facingDeg: number | null;
  fovDeg: number | null;
  goodTimes: GoodTimes;
  visibility: Visibility;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface Photo {
  id: string;
  spotId: string;
  kind: 'of_location' | 'taken_here';
  url: string;
  thumbUrl: string;
  w: number;
  h: number;
  takenAt: string | null;
  caption: string;
  createdAt: string;
}

export interface Settings {
  home: { name: string; lat: number; lng: number; radiusKm: number };
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
  allowSignup: boolean;
  allowPrivateRemotes: boolean;
  eventScoutUrl: string;
  freightSpeedLoadedKmh: number;
  freightSpeedEmptyKmh: number;
  corsOrigins: string[];
}

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
  kind?: string;
}

export interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
  display: string;
}

export interface Remote {
  id: string;
  owner_id: string;
  url: string;
  last_sync: string | null;
  last_error: string | null;
  created_at: string;
}

export interface Share {
  token: string;
  owner_id: string;
  filter: string;
  created_at: string;
  revoked_at: string | null;
}

export class Unauthorized extends Error {
  constructor(message = 'Sign in required') {
    super(message);
    this.name = 'Unauthorized';
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Unauthorized(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  // --- auth ---
  authStatus: () => fetch('/api/auth/status').then((r) => json<AuthStatus>(r)),
  setup: (username: string, password: string) =>
    fetch('/api/auth/setup', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password }) })
      .then((r) => json<{ ok: boolean; user: User }>(r)),
  signup: (username: string, password: string) =>
    fetch('/api/auth/signup', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password }) })
      .then((r) => json<{ ok: boolean; user: User }>(r)),
  login: (username: string, password: string) =>
    fetch('/api/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password }) })
      .then((r) => json<{ ok: boolean; user: User }>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),

  // --- users (admin) ---
  users: () => fetch('/api/users').then((r) => json<User[]>(r)),
  createUser: (username: string, password: string, role: Role) =>
    fetch('/api/users', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password, role }) })
      .then((r) => json<User>(r)),
  updateUser: (id: string, patch: { role?: Role; password?: string }) =>
    fetch(`/api/users/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => json<User>(r)),
  deleteUser: (id: string) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- settings ---
  settings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  saveSettings: (s: Partial<Settings>) =>
    fetch('/api/settings', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Settings>(r)),

  // --- geocode / version ---
  geocode: (q: string) => fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => json<GeocodeResult[]>(r)),
  version: () => fetch('/api/version').then((r) => json<VersionInfo>(r)),

  // --- places ---
  places: () => fetch('/api/places').then((r) => json<Place[]>(r)),
  place: (id: string) => fetch(`/api/places/${id}`).then((r) => json<Place>(r)),
  createPlace: (p: Partial<Place>) =>
    fetch('/api/places', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(p) }).then((r) => json<Place>(r)),
  updatePlace: (id: string, p: Partial<Place>) =>
    fetch(`/api/places/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(p) }).then((r) => json<Place>(r)),
  deletePlace: (id: string) => fetch(`/api/places/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- spots ---
  spots: (query: { bbox?: string; near?: string; radiusKm?: number; placeId?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return fetch(`/api/spots${qs ? `?${qs}` : ''}`).then((r) => json<Spot[]>(r));
  },
  spot: (id: string) => fetch(`/api/spots/${id}`).then((r) => json<Spot>(r)),
  createSpot: (s: Partial<Spot>) =>
    fetch('/api/spots', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Spot>(r)),
  updateSpot: (id: string, s: Partial<Spot>) =>
    fetch(`/api/spots/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Spot>(r)),
  deleteSpot: (id: string) => fetch(`/api/spots/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- photos ---
  spotPhotos: (spotId: string) => fetch(`/api/spots/${spotId}/photos`).then((r) => json<Photo[]>(r)),
  updatePhoto: (id: string, patch: { caption?: string; kind?: Photo['kind'] }) =>
    fetch(`/api/photos/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => json<Photo>(r)),
  uploadPhoto: (spotId: string, photo: Blob, thumb: Blob, meta: { kind?: string; caption?: string; takenAt?: string; w?: number; h?: number } = {}) => {
    const form = new FormData();
    form.append('photo', photo);
    form.append('thumb', thumb);
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) form.append(k, String(v));
    return fetch(`/api/spots/${spotId}/photos`, { method: 'POST', body: form }).then((r) => json<Photo>(r));
  },
  deletePhoto: (id: string) => fetch(`/api/photos/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- import / export ---
  importGeoJson: (featureCollection: unknown) =>
    fetch('/api/import', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(featureCollection) })
      .then((r) => json<{ places: number; spots: number }>(r)),
  exportGeoJsonUrl: () => '/api/export.geojson',
  exportGpxUrl: () => '/api/export.gpx',

  // --- shares ---
  shares: () => fetch('/api/shares').then((r) => json<Share[]>(r)),
  createShare: (filter: unknown = {}) =>
    fetch('/api/shares', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(filter) }).then((r) => json<{ token: string }>(r)),
  revokeShare: (token: string) => fetch(`/api/shares/${token}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- remotes ---
  remotes: () => fetch('/api/remotes').then((r) => json<Remote[]>(r)),
  addRemote: (url: string) =>
    fetch('/api/remotes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ url }) }).then((r) => json<Remote>(r)),
  deleteRemote: (id: string) => fetch(`/api/remotes/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  syncRemote: (id: string) => fetch(`/api/remotes/${id}/sync`, { method: 'POST' }).then((r) => json<{ places: number; spots: number; sightings: number }>(r)),
};

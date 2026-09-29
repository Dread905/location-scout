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
  /** From the server's spot payload: how many photos, and the cover photo's thumbnail (null when none). */
  photoCount?: number;
  coverThumbUrl?: string | null;
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
  /** Never the key itself — only whether one is set, and whether the environment pins it. */
  tfnswApiKeySet: boolean;
  tfnswApiKeyFromEnv: boolean;
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

// --- phase 3: feeds ---

export interface Plane { hex: string; flight: string; lat: number; lon: number; track: number | null; gs: number | null; alt_baro: number | null; t: string; seen: number }

export interface RailFeature extends GeoJSON.Feature { properties: { id: string; kind: 'rail' | 'industrial' | 'mine' | 'works'; usage?: string; service?: string; name?: string } }

export interface TrainPosition {
  tripId: string; routeId: string; route: string; headsign: string; lat: number; lng: number; status: 'live' | 'scheduled'; delaySec: number;
  bearing?: number | null; speedMps?: number | null; carriages?: number | null; network?: 'sydneytrains' | 'nswtrains' | null;
  path?: [number, number][]; pathAtKm?: number;
  /** Server snapped it onto OSM track; when false/absent the client snaps to the basemap's rail lines instead. */
  snapped?: boolean;
}
export interface TrainPass { tripId: string; routeId: string; route: string; headsign: string; at: string }
export interface TrainsStatus { configured: boolean; lastImport: string | null; tripCount: number }

export interface ScoutEvent {
  group: string; title: string; description: string; startTime: string; endTime: string; venueName: string;
  address: string; locality: string; lat: number; lng: number; imageUrl: string | null; category: string; goodDuring: boolean;
}
export interface NearbyResult {
  events: ScoutEvent[];
  crowd: { venue: string; live: number | null; typical: number | null; score: number | null; bestWindow: string | null } | null;
  status: 'ok' | 'not_configured';
}

export interface Candidate { id: string; source: string; ref: string; name: string; lat: number; lng: number; tags: Record<string, string>; fetchedAt: string }
export interface CommonsImage { title: string; pageUrl: string; thumbUrl: string | null; lat: number; lng: number }

export interface TaskStatus {
  name: string; label: string; description: string; enabled: boolean; canDisable: boolean; manualOnly: boolean;
  running: boolean; blockedBy: string | null; schedule: string | null; intervalMinutes: number | null;
  lastRun: string | null; lastResult: string | null; lastOk: boolean | null; nextDue: string | null; log: string[];
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

export interface WeatherHour {
  time: string; // ISO (UTC)
  tempC: number | null;
  cloudPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipMm: number | null;
  precipProbPct: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  visibilityM: number | null;
  weatherCode: number | null;
  fogLikely: boolean;
}
export interface WeatherForecast { lat: number; lng: number; fetchedAt: string; hourly: WeatherHour[] }

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
  saveSettings: (s: Partial<Settings> & { tfnswApiKey?: string; clearTfnswApiKey?: boolean }) =>
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
  syncRemote: (id: string) => fetch(`/api/remotes/${id}/sync`, { method: 'POST' }).then((r) => json<{ places: number; spots: number }>(r)),

  // --- weather (Open-Meteo, hourly, UTC) ---
  weather: (lat: number, lng: number, days = 7) => fetch(`/api/weather?lat=${lat}&lng=${lng}&days=${days}`).then((r) => json<WeatherForecast>(r)),
  // --- planes ---
  planes: (lat: number, lng: number, nm = 40) => fetch(`/api/planes?lat=${lat}&lng=${lng}&nm=${nm}`).then((r) => json<Plane[]>(r)),
  buildings: (lat: number, lng: number, r = 250) => fetch(`/api/buildings?lat=${lat}&lng=${lng}&r=${r}`).then((r) => json<GeoJSON.FeatureCollection>(r)),

  // --- rail ---
  rail: () => fetch('/api/rail').then((r) => json<GeoJSON.FeatureCollection>(r)),

  // --- trains ---
  trainsStatus: () => fetch('/api/trains/status').then((r) => json<TrainsStatus>(r)),
  trains: (at?: Date) => fetch(`/api/trains${at ? `?at=${at.toISOString()}` : ''}`).then((r) => json<{ configured: boolean; positions: TrainPosition[] }>(r)),
  trainPassesAt: (lat: number, lng: number, hours = 6) =>
    fetch(`/api/trains/passes?lat=${lat}&lng=${lng}&hours=${hours}`).then((r) => json<{ configured: boolean; passes: TrainPass[] }>(r)),
  spotTrains: (spotId: string, hours = 6) => fetch(`/api/spots/${spotId}/trains?hours=${hours}`).then((r) => json<{ configured: boolean; passes: TrainPass[] }>(r)),

  // --- Event Scout ---
  spotNearby: (spotId: string) => fetch(`/api/spots/${spotId}/nearby`).then((r) => json<NearbyResult>(r)),
  placeNearby: (placeId: string) => fetch(`/api/places/${placeId}/nearby`).then((r) => json<NearbyResult>(r)),

  // --- candidates + Commons ---
  candidates: (bbox?: string) => fetch(`/api/candidates${bbox ? `?bbox=${bbox}` : ''}`).then((r) => json<Candidate[]>(r)),
  promoteCandidate: (id: string) => fetch(`/api/candidates/${id}/promote`, { method: 'POST' }).then((r) => json<Spot>(r)),
  spotCommons: (spotId: string) => fetch(`/api/spots/${spotId}/commons`).then((r) => json<CommonsImage[]>(r)),

  // --- background tasks ---
  tasks: () => fetch('/api/tasks').then((r) => json<{ tasks: TaskStatus[] }>(r)),
  runTask: (name: string) => fetch(`/api/tasks/${name}/run`, { method: 'POST' }).then((r) => json<{ ok: boolean; message: string }>(r)),

  // --- Event Scout test (TfNSW status is under "trains" above; never the key itself) ---
  testEventScout: (url: string) => fetch(`/api/eventscout/test?url=${encodeURIComponent(url)}`).then((r) => json<{ ok: boolean; message: string }>(r)),
};

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, photosDir } from './db.js';
import {
  InstanceMode, SessionUser, Visibility,
  canEdit, canRead, needsAuth, readCookie, SESSION_COOKIE,
  loginBlockedFor, noteLoginFailure, noteLoginSuccess,
} from './auth.js';
import {
  checkUserPassword, createUser, deleteUser, findUserById, listUsers,
  newSessionToken, seedAdminFromEnv, sessionUser, setUserPassword, setUserRole, userCount,
} from './authStore.js';
import { corsDecision, readOrigins } from './cors.js';
import { applySettingsUpdate, getSettings, publicSettings, tfnswKey } from './settings.js';
import { geocode } from './geocode.js';
import { bboxFromRadius, haversine, parseBbox, parseLatLng } from './geo.js';
import { parseGoodTimes, GoodTimesError, DEFAULT_GOOD_TIMES } from './goodTimes.js';
import { fetchPlanes } from './feeds/planes.js';
import { fetchWeather } from './feeds/weather.js';
import { fetchBuildings } from './sources/osm.js';
import {
  buildPointPassesResponse, combinedFeedData, combinedRealtime, emptyFeedData, nextPasses, parsePointPassRequest, predictTrainPositions, tripCount, TRAIN_FEEDS,
} from './feeds/trains.js';
import { nearbyFor } from './feeds/eventScout.js';
import { getCachedRail, requestTilesForUnsnapped, trackGraphFor } from './sources/rail.js';
import { commonsNearbyCached } from './sources/commons.js';
import { coverFields, deleteImages, detectImageType, MAX_PHOTO_BYTES, parseMultipart, saveImage, SPOT_COVER_COLS } from './photos.js';
import { buildGpx } from './gpx.js';
import { buildFeatureCollection, importFeatureCollection, ShareBundle, syncRemote } from './share.js';
import { assertPublicUrl, guardedFetch } from './ssrf.js';
import { tasks } from './tasks/tasks.js';
import { runDueTasksOnStartup, startScheduler } from './tasks/scheduler.js';
import { versionInfo } from './version.js';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      user: SessionUser | null;
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

seedAdminFromEnv(db);

function instanceMode(): InstanceMode {
  return process.env.INSTANCE_MODE === 'public' ? 'public' : 'private';
}

function trustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// --- CORS, then the session, then the gate ---------------------------------

app.use('/api', (req, res, next) => {
  const decision = corsDecision(
    {
      origin: req.headers.origin,
      method: req.method,
      path: req.baseUrl + req.path,
      requestMethod: req.headers['access-control-request-method'] as string | undefined,
    },
    readOrigins(getSettings(db).corsOrigins),
    instanceMode()
  );
  if (decision) {
    res.vary(decision.vary);
    res.set(decision.headers);
    if (decision.preflight) return res.sendStatus(204);
  }
  next();
});

app.use('/api', (req, _res, next) => {
  req.user = sessionUser(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  next();
});

app.use('/api', (req, res, next) => {
  if (!needsAuth(req.method, req.baseUrl + req.path, instanceMode())) return next();
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in required' });
});

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'Admins only' });
  return false;
}

// --- auth -------------------------------------------------------------------

app.get('/api/auth/status', (req, res) => {
  const mode = instanceMode();
  res.json({
    mode,
    needsSetup: userCount(db) === 0,
    authed: Boolean(req.user),
    user: req.user ? findUserById(db, req.user.id) : null,
    allowSignup: getSettings(db).allowSignup,
  });
});

/** First run: create the admin, once, while there are no users at all. */
app.post('/api/auth/setup', (req, res) => {
  if (userCount(db) > 0) return res.status(409).json({ error: 'Already set up' });
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'username and an 8+ character password are required' });
  }
  const user = createUser(db, username, password, 'admin');
  const { token, maxAgeMs } = newSessionToken(db, user);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: maxAgeMs });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/signup', (req, res) => {
  if (!getSettings(db).allowSignup) return res.status(403).json({ error: 'Sign-up is switched off' });
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'username and an 8+ character password are required' });
  }
  if (findUserByUsernameSafe(username)) return res.status(409).json({ error: 'Username taken' });
  const user = createUser(db, username, password, 'contributor');
  const { token, maxAgeMs } = newSessionToken(db, user);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: maxAgeMs });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});
function findUserByUsernameSafe(username: string) {
  return db.handle.prepare('SELECT id FROM users WHERE username = ?').get(username);
}

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const blocked = loginBlockedFor(ip);
  if (blocked > 0) return res.status(429).json({ error: `Too many attempts — try again in ${Math.ceil(blocked / 1000)}s` });
  const { username, password } = req.body as { username?: string; password?: string };
  const user = typeof username === 'string' && typeof password === 'string' ? checkUserPassword(db, username, password) : null;
  if (!user) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  noteLoginSuccess(ip);
  const { token, maxAgeMs } = newSessionToken(db, { id: user.id, role: user.role });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: maxAgeMs });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// --- users (admin) -----------------------------------------------------------

app.get('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(listUsers(db));
});
app.post('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { username, password, role } = req.body as { username?: string; password?: string; role?: string };
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'username and an 8+ character password are required' });
  if (role !== 'admin' && role !== 'contributor') return res.status(400).json({ error: 'role must be admin or contributor' });
  if (findUserByUsernameSafe(username)) return res.status(409).json({ error: 'Username taken' });
  res.json(createUser(db, username, password, role));
});
app.patch('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { role, password } = req.body as { role?: string; password?: string };
  if (role) {
    if (role !== 'admin' && role !== 'contributor') return res.status(400).json({ error: 'role must be admin or contributor' });
    setUserRole(db, req.params.id, role);
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'password must be 8+ characters' });
    setUserPassword(db, req.params.id, password);
  }
  res.json(findUserById(db, req.params.id) ?? null);
});
app.delete('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  deleteUser(db, req.params.id);
  res.json({ ok: true });
});

// --- settings -----------------------------------------------------------------

app.get('/api/settings', (_req, res) => res.json(publicSettings(getSettings(db))));
app.put('/api/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { settings, keyChanged } = applySettingsUpdate(db, (req.body ?? {}) as Record<string, unknown>);
  // A new key means timetables can now be pulled: start the import in the background.
  if (keyChanged && settings.tfnswApiKey) {
    for (const name of ['trains-static-nswtrains', 'trains-static-sydneytrains']) {
      tasks.run(name, { force: true }).catch(() => {});
    }
  }
  res.json(publicSettings(settings));
});

// --- geocode / version ----------------------------------------------------------

app.get('/api/geocode', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json([]);
    res.json(await geocode(db, q));
  } catch (err) { next(err); }
});

app.get('/api/version', (_req, res) => res.json(versionInfo()));

// --- places / spots: shared visibility helpers ---------------------------------

/** SQL fragment (with its params) restricting rows to what `user` may list. Unlisted rows never appear in a list. */
function listVisibilityWhere(user: SessionUser | null | undefined): { sql: string; params: string[] } {
  if (user?.role === 'admin') return { sql: "visibility IN ('public','private')", params: [] };
  if (user) return { sql: "(visibility = 'public' OR (visibility = 'private' AND owner_id = ?))", params: [user.id] };
  return { sql: "visibility = 'public'", params: [] };
}

interface PlaceRow {
  id: string; owner_id: string; name: string; notes: string; access: string; lat: number; lng: number;
  geom: string | null; visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
}
function placeJson(r: PlaceRow) {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, notes: r.notes, access: r.access, lat: r.lat, lng: r.lng,
    geom: r.geom ? JSON.parse(r.geom) : null, visibility: r.visibility, source: r.source, sourceRef: r.source_ref,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface SpotRow {
  id: string; place_id: string | null; owner_id: string; name: string; notes: string; lat: number; lng: number;
  tags: string; facing_deg: number | null; fov_deg: number | null; good_times: string;
  visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
  photo_count?: number; cover_id?: string | null;
}
function spotJson(r: SpotRow) {
  return {
    id: r.id, placeId: r.place_id, ownerId: r.owner_id, name: r.name, notes: r.notes, lat: r.lat, lng: r.lng,
    tags: JSON.parse(r.tags), facingDeg: r.facing_deg, fovDeg: r.fov_deg, goodTimes: JSON.parse(r.good_times),
    visibility: r.visibility, source: r.source, sourceRef: r.source_ref, createdAt: r.created_at, updatedAt: r.updated_at,
    ...coverFields(r),
  };
}

function isVisibility(v: unknown): v is Visibility {
  return v === 'private' || v === 'unlisted' || v === 'public';
}

// --- places --------------------------------------------------------------------

app.get('/api/places', (req, res) => {
  const { sql, params } = listVisibilityWhere(req.user);
  const rows = db.handle.prepare(`SELECT * FROM places WHERE ${sql} ORDER BY name`).all(...params) as unknown as PlaceRow[];
  res.json(rows.map(placeJson));
});

app.post('/api/places', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO places (id, owner_id, name, notes, access, lat, lng, geom, visibility, source, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, b.name.trim(), String(b.notes ?? ''), String(b.access ?? ''), b.lat, b.lng,
      b.geom ? JSON.stringify(b.geom) : null, visibility, 'manual', '', now, now);
  res.status(201).json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(id) as unknown as PlaceRow));
});

app.get('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(placeJson(row));
});

app.patch('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const next = {
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    access: typeof b.access === 'string' ? b.access : row.access,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    geom: b.geom !== undefined ? (b.geom ? JSON.stringify(b.geom) : null) : row.geom,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE places SET name=?, notes=?, access=?, lat=?, lng=?, geom=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.name, next.notes, next.access, next.lat, next.lng, next.geom, next.visibility, new Date().toISOString(), row.id);
  res.json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(row.id) as unknown as PlaceRow));
});

app.delete('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  // Spots outlive their place: detached, not deleted.
  db.handle.prepare('UPDATE spots SET place_id = NULL WHERE place_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM places WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- spots ----------------------------------------------------------------------

app.get('/api/spots', (req, res) => {
  try {
    const { sql, params } = listVisibilityWhere(req.user);
    const clauses = [sql];
    const args: any[] = [...params]; // mixed string/number bind params for the prepared statement below

    if (typeof req.query.placeId === 'string') {
      clauses.push('place_id = ?');
      args.push(req.query.placeId);
    }

    let bbox = null as ReturnType<typeof parseBbox> | null;
    if (typeof req.query.bbox === 'string') bbox = parseBbox(req.query.bbox);
    else if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusKm = Number(req.query.radiusKm ?? 10);
      bbox = bboxFromRadius(lat, lng, radiusKm);
    }
    if (bbox) {
      clauses.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
      args.push(bbox.south, bbox.north, bbox.west, bbox.east);
    }

    let rows = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE ${clauses.join(' AND ')} ORDER BY name`).all(...args) as unknown as SpotRow[];

    // near= is a circle; the bbox above is only its bounding box.
    if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusM = Number(req.query.radiusKm ?? 10) * 1000;
      rows = rows.filter((r) => haversine(lat, lng, r.lat, r.lng) <= radiusM);
    }

    res.json(rows.map(spotJson));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/spots', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  let goodTimes;
  try {
    goodTimes = parseGoodTimes(b.goodTimes);
  } catch (err) {
    if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', '', ?, ?)`
    )
    .run(id, b.placeId ? String(b.placeId) : null, req.user!.id, b.name.trim(), String(b.notes ?? ''), b.lat, b.lng,
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []), typeof b.facingDeg === 'number' ? b.facingDeg : null,
      typeof b.fovDeg === 'number' ? b.fovDeg : null, JSON.stringify(goodTimes), visibility, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

app.get('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(req.params.id) as unknown as SpotRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(spotJson(row));
});

app.patch('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  let goodTimes = JSON.parse(row.good_times);
  if (b.goodTimes !== undefined) {
    try {
      goodTimes = parseGoodTimes(b.goodTimes);
    } catch (err) {
      if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }
  const next = {
    place_id: b.placeId !== undefined ? (b.placeId ? String(b.placeId) : null) : row.place_id,
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    tags: b.tags !== undefined ? JSON.stringify(Array.isArray(b.tags) ? b.tags : []) : row.tags,
    facing_deg: b.facingDeg !== undefined ? (typeof b.facingDeg === 'number' ? b.facingDeg : null) : row.facing_deg,
    fov_deg: b.fovDeg !== undefined ? (typeof b.fovDeg === 'number' ? b.fovDeg : null) : row.fov_deg,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE spots SET place_id=?, name=?, notes=?, lat=?, lng=?, tags=?, facing_deg=?, fov_deg=?, good_times=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.place_id, next.name, next.notes, next.lat, next.lng, next.tags, next.facing_deg, next.fov_deg,
      JSON.stringify(goodTimes), next.visibility, new Date().toISOString(), row.id);
  res.json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(row.id) as unknown as SpotRow));
});

app.delete('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const photos = db.handle.prepare('SELECT file, thumb FROM photos WHERE spot_id = ?').all(row.id) as { file: string; thumb: string }[];
  deleteImages(photos.flatMap((p) => [p.file, p.thumb]));
  db.handle.prepare('DELETE FROM photos WHERE spot_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM spots WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- photos -----------------------------------------------------------------

interface PhotoRow {
  id: string; spot_id: string; owner_id: string; kind: string; file: string; thumb: string;
  w: number; h: number; taken_at: string | null; caption: string; created_at: string;
}
function photoJson(r: PhotoRow) {
  return {
    id: r.id, spotId: r.spot_id, kind: r.kind, url: `/api/photos/${r.id}/file`, thumbUrl: `/api/photos/${r.id}/thumb`,
    w: r.w, h: r.h, takenAt: r.taken_at, caption: r.caption, createdAt: r.created_at,
  };
}

app.post('/api/spots/:id/photos', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot) return res.status(404).json({ error: 'Not found' });
    if (!canEdit(spot.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });

    const { fields, files } = await parseMultipart(req, MAX_PHOTO_BYTES * 2 + 4096);
    if (!files.photo || !detectImageType(files.photo)) return res.status(400).json({ error: 'photo must be a JPEG, PNG or WebP file' });
    const thumbBuf = files.thumb && detectImageType(files.thumb) ? files.thumb : files.photo;

    const file = saveImage(files.photo);
    const thumb = saveImage(thumbBuf);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const kind = fields.kind === 'of_location' ? 'of_location' : 'taken_here';
    db.handle
      .prepare('INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, w, h, taken_at, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, spot.id, req.user!.id, kind, file, thumb, Number(fields.w ?? 0) || 0, Number(fields.h ?? 0) || 0,
        fields.takenAt || null, fields.caption ?? '', now);
    res.status(201).json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(id) as unknown as PhotoRow));
  } catch (err) { next(err); }
});

function servePhoto(variant: 'file' | 'thumb') {
  return (req: express.Request, res: express.Response) => {
    const row = db.handle.prepare('SELECT p.*, s.visibility as spot_visibility, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
      .get(req.params.id) as (PhotoRow & { spot_visibility: Visibility; spot_owner_id: string }) | undefined;
    if (!row || !canRead(row.spot_visibility, row.spot_owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
  };
}
app.get('/api/photos/:id/file', servePhoto('file'));
app.get('/api/photos/:id/thumb', servePhoto('thumb'));

app.get('/api/spots/:id/photos', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  const rows = db.handle.prepare('SELECT * FROM photos WHERE spot_id = ? ORDER BY created_at').all(spot.id) as unknown as PhotoRow[];
  res.json(rows.map(photoJson));
});

app.patch('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const caption = typeof b.caption === 'string' ? b.caption.slice(0, 500) : row.caption;
  const kind = b.kind === 'of_location' || b.kind === 'taken_here' ? b.kind : row.kind;
  db.handle.prepare('UPDATE photos SET caption = ?, kind = ? WHERE id = ?').run(caption, kind, row.id);
  res.json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(row.id) as unknown as PhotoRow));
});

app.delete('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  deleteImages([row.file, row.thumb]);
  db.handle.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- import / export ----------------------------------------------------------

app.post('/api/import', (req, res) => {
  const bundle = req.body as ShareBundle;
  if (!bundle || bundle.type !== 'FeatureCollection' || !Array.isArray(bundle.features)) {
    return res.status(400).json({ error: 'A GeoJSON FeatureCollection is required' });
  }
  res.json(importFeatureCollection(db, bundle, req.user!.id));
});

app.get('/api/export.geojson', (req, res) => {
  const bundle = buildFeatureCollection(db, req.user!.id, (id, variant) => `/api/photos/${id}/${variant}`);
  res.json(bundle);
});

app.get('/api/export.gpx', (req, res) => {
  const rows = db.handle.prepare('SELECT name, notes, lat, lng FROM spots WHERE owner_id = ?').all(req.user!.id) as
    { name: string; notes: string; lat: number; lng: number }[];
  res.type('application/gpx+xml').send(buildGpx(rows.map((r) => ({ lat: r.lat, lng: r.lng, name: r.name, desc: r.notes }))));
});

// --- shares -------------------------------------------------------------------

interface ShareRow { token: string; owner_id: string; filter: string; created_at: string; revoked_at: string | null }

app.get('/api/shares', (req, res) => {
  const rows = req.user!.role === 'admin'
    ? db.handle.prepare('SELECT * FROM shares').all()
    : db.handle.prepare('SELECT * FROM shares WHERE owner_id = ?').all(req.user!.id);
  res.json(rows);
});

app.post('/api/shares', (req, res) => {
  const token = crypto.randomBytes(18).toString('base64url');
  db.handle
    .prepare('INSERT INTO shares (token, owner_id, filter, created_at) VALUES (?, ?, ?, ?)')
    .run(token, req.user!.id, JSON.stringify(req.body ?? {}), new Date().toISOString());
  res.status(201).json({ token });
});

app.delete('/api/shares/:token', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token) as unknown as ShareRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('UPDATE shares SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), req.params.token);
  res.json({ ok: true });
});

function activeShare(token: string): ShareRow | null {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(token) as unknown as ShareRow | undefined;
  return row && !row.revoked_at ? row : null;
}

/** The bundle a share token grants — no session needed, the token is the credential. */
app.get('/api/share/:token', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  res.json(buildFeatureCollection(db, share.owner_id, (id, variant) => `/api/share/${req.params.token}/photos/${id}/${variant}`));
});

app.get('/api/share/:token/photos/:id/:variant', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  const variant = req.params.variant === 'thumb' ? 'thumb' : 'file';
  const row = db.handle.prepare('SELECT p.* FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ? AND s.owner_id = ?')
    .get(req.params.id, share.owner_id) as unknown as PhotoRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
});

// --- remotes --------------------------------------------------------------------

interface RemoteRow { id: string; owner_id: string; url: string; last_sync: string | null; last_error: string | null; created_at: string }

app.get('/api/remotes', (req, res) => {
  const rows = req.user!.role === 'admin'
    ? db.handle.prepare('SELECT * FROM remotes').all()
    : db.handle.prepare('SELECT * FROM remotes WHERE owner_id = ?').all(req.user!.id);
  res.json(rows);
});

app.post('/api/remotes', async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    await assertPublicUrl(url, getSettings(db).allowPrivateRemotes);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const id = crypto.randomUUID();
  db.handle.prepare('INSERT INTO remotes (id, owner_id, url, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, url, new Date().toISOString());
  res.status(201).json(db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(id));
});

app.delete('/api/remotes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM remotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/remotes/:id/sync', async (req, res, next) => {
  try {
    const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const result = await syncRemote(db, row, getSettings(db).allowPrivateRemotes);
    db.handle.prepare('UPDATE remotes SET last_sync = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
    res.json(result);
  } catch (err) {
    db.handle.prepare('UPDATE remotes SET last_error = ? WHERE id = ?').run((err as Error).message, req.params.id);
    next(err);
  }
});

// --- tasks (read-only status; the scheduler drives the actual runs) -------------

app.get('/api/tasks', (req, res) => {
  const since = Number(req.query.since ?? 0);
  res.json({ tasks: tasks.statuses(), ...tasks.since(since) });
});
app.post('/api/tasks/:name/run', (req, res, next) => {
  if (!requireAdmin(req, res)) return;
  tasks.run(req.params.name, { force: true }).then((result) => res.json(result)).catch(next);
});

// --- planes -------------------------------------------------------------------

app.get('/api/planes', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const nm = Number(req.query.nm ?? 40);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.ADSB_URL ?? 'https://api.adsb.lol';
    res.json(await fetchPlanes(baseUrl, lat, lng, nm));
  } catch (err) { next(err); }
});

// --- weather ------------------------------------------------------------------

app.get('/api/weather', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.OPEN_METEO_URL ?? 'https://api.open-meteo.com';
    res.json(await fetchWeather(baseUrl, lat, lng, Number.isFinite(days) ? days : 7));
  } catch (err) { next(err); }
});

// Building footprints around a point, for Plan shoot's building shadows (the page has no map to read vector tiles from).
app.get('/api/buildings', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const r = Number(req.query.r ?? 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    const radius = Number.isFinite(r) ? r : 250;
    // Footprints barely change: cache per ~10 m cell for a week so Overpass outages don't blank building shade.
    const key = `buildings:${lat.toFixed(4)},${lng.toFixed(4)}:${Math.round(radius)}`;
    const cached = db.getKv(key);
    if (cached) return res.type('application/json').send(cached);
    try {
      const fc = await fetchBuildings(lat, lng, radius);
      db.setKv(key, JSON.stringify(fc), new Date(Date.now() + 7 * 86_400_000).toISOString());
      res.json(fc);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  } catch (err) { next(err); }
});

// --- rail network --------------------------------------------

app.get('/api/rail', (_req, res) => res.json(getCachedRail(db)));

// --- trains -----------------------------------------------------------------

app.get('/api/trains/status', (_req, res) => {
  const configured = Boolean(tfnswKey(db));
  const lastImport = TRAIN_FEEDS.map((f) => db.getKv(`trains:lastImport:${f}`)).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
  res.json({ configured, lastImport, tripCount: tripCount(db) });
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.json({ configured: false, positions: [] });
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    // Realtime describes *now*; only mix it in when asked about (roughly) now.
    const nearNow = Math.abs(at.getTime() - Date.now()) < 5 * 60_000;
    const [feed, realtime] = [combinedFeedData(db), nearNow ? await combinedRealtime(key) : []];
    const unsnapped = predictTrainPositions(feed, at, realtime);
    const track = trackGraphFor(db, unsnapped);
    const positions = predictTrainPositions(feed, at, realtime, track);
    requestTilesForUnsnapped(db, positions);
    res.json({ configured: true, positions });
  } catch (err) { next(err); }
});

app.get('/api/trains/passes', (req, res) => {
  const parsed = parsePointPassRequest(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const key = tfnswKey(db);
  res.json(buildPointPassesResponse(Boolean(key), key ? combinedFeedData(db) : emptyFeedData(), parsed.point, parsed.hours, new Date()));
});

app.get('/api/spots/:id/trains', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  if (!tfnswKey(db)) return res.json({ configured: false, passes: [] });
  const hours = Number(req.query.hours ?? 6);
  const passes = nextPasses(combinedFeedData(db), spot, hours, new Date());
  res.json({ configured: true, passes });
});

// --- Event Scout: nearby events and busyness --------------------------------------

function nearbyOriginForSpot(row: SpotRow): { lat: number; lng: number } {
  if (row.place_id) {
    const place = db.handle.prepare('SELECT lat, lng FROM places WHERE id = ?').get(row.place_id) as { lat: number; lng: number } | undefined;
    if (place) return place;
  }
  return { lat: row.lat, lng: row.lng };
}

app.get('/api/spots/:id/nearby', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    const origin = nearbyOriginForSpot(spot);
    const goodTimes = JSON.parse(spot.good_times) as { eventKeywords?: string[] };
    res.json(await nearbyFor(db, getSettings(db).eventScoutUrl, origin.lat, origin.lng, goodTimes.eventKeywords ?? []));
  } catch (err) { next(err); }
});

app.get('/api/places/:id/nearby', async (req, res, next) => {
  try {
    const place = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
    if (!place || !canRead(place.visibility, place.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.json(await nearbyFor(db, getSettings(db).eventScoutUrl, place.lat, place.lng, []));
  } catch (err) { next(err); }
});

// --- candidates (OSM) + Commons inspiration ---------------------------------------

app.get('/api/candidates', (req, res) => {
  try {
    let rows: any[];
    if (typeof req.query.bbox === 'string') {
      const b = parseBbox(req.query.bbox);
      rows = db.handle.prepare('SELECT * FROM candidates WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').all(b.south, b.north, b.west, b.east);
    } else {
      rows = db.handle.prepare('SELECT * FROM candidates').all();
    }
    res.json(rows.map((r) => ({ id: r.id, source: r.source, ref: r.ref, name: r.name, lat: r.lat, lng: r.lng, tags: JSON.parse(r.tags), fetchedAt: r.fetched_at })));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/candidates/:id/promote', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '', ?, ?, '[]', NULL, NULL, ?, 'private', 'osm', ?, ?, ?)`
    )
    .run(id, req.user!.id, row.name || 'Candidate', row.lat, row.lng, JSON.stringify(DEFAULT_GOOD_TIMES), row.ref, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

app.get('/api/eventscout/test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const url = String(req.query.url ?? getSettings(db).eventScoutUrl ?? '');
  if (!url) return res.json({ ok: false, message: 'No URL set' });
  try {
    const buf = await guardedFetch(`${url.replace(/\/$/, '')}/api/density/areas`, true);
    const data = JSON.parse(buf.toString('utf8')) as { areas?: unknown[] };
    res.json({ ok: true, message: `Reached it — ${data.areas?.length ?? 0} density area(s)` });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message });
  }
});

app.get('/api/spots/:id/commons', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.json(await commonsNearbyCached(db, spot.lat, spot.lng));
  } catch (err) { next(err); }
});

// --- 404 + error handling, then the built frontend -------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.baseUrl}${req.path}` });
});

app.use('/api', (err: Error & { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message || 'Bad request' });
});

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const PORT = Number(process.env.API_PORT ?? 3003);
app.listen(PORT, () => {
  console.log(`location-scout server listening on http://localhost:${PORT}`);
});

startScheduler();
runDueTasksOnStartup();

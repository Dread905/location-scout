import crypto from 'node:crypto';
import { Db } from './db.js';
import { Visibility } from './auth.js';
import { parseGoodTimes, GoodTimes } from './goodTimes.js';
import { guardedFetch } from './ssrf.js';
import { saveImage } from './photos.js';

/**
 * Share bundles: a GeoJSON FeatureCollection of places, spots and sightings,
 * and the upsert that turns one instance's bundle into another's rows. Used
 * both by `GET /api/share/:token` (build) and remote sync (build on the far
 * side, upsert on this one).
 */

export interface ShareFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown> & { kind: 'place' | 'spot' | 'sighting'; id: string };
}

export interface ShareBundle {
  type: 'FeatureCollection';
  features: ShareFeature[];
}

interface PlaceRow {
  id: string; owner_id: string; name: string; notes: string; access: string; lat: number; lng: number;
  geom: string | null; visibility: Visibility; source: string; source_ref: string;
}
interface SpotRow {
  id: string; place_id: string | null; owner_id: string; name: string; notes: string; lat: number; lng: number;
  tags: string; facing_deg: number | null; fov_deg: number | null; good_times: string;
  visibility: Visibility; source: string; source_ref: string;
}
interface SightingRow {
  id: string; owner_id: string; kind: string; direction: string; lat: number; lng: number; line_ref: string;
  seen_at: string; notes: string; visibility: Visibility; source: string; source_ref: string;
}
interface PhotoRow { id: string; spot_id: string; kind: string; file: string; thumb: string; caption: string; taken_at: string | null }

/** Build the bundle for everything `ownerId` owns. The owner picked what to share by creating the link. */
export function buildFeatureCollection(
  db: Db,
  ownerId: string,
  photoUrl: (photoId: string, variant: 'file' | 'thumb') => string
): ShareBundle {
  const places = db.handle.prepare('SELECT * FROM places WHERE owner_id = ?').all(ownerId) as unknown as PlaceRow[];
  const spots = db.handle.prepare('SELECT * FROM spots WHERE owner_id = ?').all(ownerId) as unknown as SpotRow[];
  const sightings = db.handle.prepare('SELECT * FROM sightings WHERE owner_id = ?').all(ownerId) as unknown as SightingRow[];
  const photosBySpot = new Map<string, PhotoRow[]>();
  for (const p of db.handle.prepare('SELECT * FROM photos WHERE spot_id IN (SELECT id FROM spots WHERE owner_id = ?)').all(ownerId) as unknown as PhotoRow[]) {
    const list = photosBySpot.get(p.spot_id) ?? [];
    list.push(p);
    photosBySpot.set(p.spot_id, list);
  }

  const features: ShareFeature[] = [];
  for (const pl of places) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pl.lng, pl.lat] },
      properties: {
        kind: 'place', id: pl.id, name: pl.name, notes: pl.notes, access: pl.access,
        geom: pl.geom ? JSON.parse(pl.geom) : null, visibility: pl.visibility, source: pl.source, sourceRef: pl.source_ref,
      },
    });
  }
  for (const s of spots) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        kind: 'spot', id: s.id, placeId: s.place_id, name: s.name, notes: s.notes,
        tags: JSON.parse(s.tags), facingDeg: s.facing_deg, fovDeg: s.fov_deg,
        goodTimes: JSON.parse(s.good_times), visibility: s.visibility, source: s.source, sourceRef: s.source_ref,
        photos: (photosBySpot.get(s.id) ?? []).map((p) => ({
          url: photoUrl(p.id, 'file'), thumbUrl: photoUrl(p.id, 'thumb'), kind: p.kind, caption: p.caption, takenAt: p.taken_at,
        })),
      },
    });
  }
  for (const s of sightings) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        kind: 'sighting', id: s.id, sightingKind: s.kind, direction: s.direction, lineRef: s.line_ref,
        seenAt: s.seen_at, notes: s.notes, visibility: s.visibility, source: s.source, sourceRef: s.source_ref,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export interface UpsertResult { places: number; spots: number; sightings: number }

/**
 * `POST /api/import`: a plain GeoJSON FeatureCollection of places and spots,
 * with no photos. Upserts by `source`+`sourceRef` when a feature carries
 * both (a re-import of something already tagged, e.g. a promoted OSM
 * candidate); otherwise it's a fresh row tagged `source='import'`.
 */
export function importFeatureCollection(db: Db, bundle: ShareBundle, ownerId: string): { places: number; spots: number } {
  const now = new Date().toISOString();
  let places = 0;
  let spots = 0;
  const placeIdMap = new Map<string, string>();

  const findBySourceRef = (table: 'places' | 'spots', source: string, sourceRef: string): { id: string } | undefined =>
    db.handle.prepare(`SELECT id FROM ${table} WHERE source = ? AND source_ref = ?`).get(source, sourceRef) as any;

  for (const f of bundle.features.filter((x) => x.properties.kind === 'place')) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const source = typeof p.source === 'string' && p.source ? p.source : 'import';
    const sourceRef = typeof p.sourceRef === 'string' ? p.sourceRef : '';
    const existing = sourceRef ? findBySourceRef('places', source, sourceRef) : undefined;
    const localId = existing?.id ?? crypto.randomUUID();
    if (p.id) placeIdMap.set(String(p.id), localId);
    db.handle
      .prepare(
        `INSERT INTO places (id, owner_id, name, notes, access, lat, lng, geom, visibility, source, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, notes=excluded.notes, access=excluded.access,
           lat=excluded.lat, lng=excluded.lng, geom=excluded.geom, updated_at=excluded.updated_at`
      )
      .run(localId, ownerId, String(p.name ?? ''), String(p.notes ?? ''), String(p.access ?? ''), lat, lng,
        p.geom ? JSON.stringify(p.geom) : null, source, sourceRef, now, now);
    places++;
  }

  for (const f of bundle.features.filter((x) => x.properties.kind === 'spot')) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const source = typeof p.source === 'string' && p.source ? p.source : 'import';
    const sourceRef = typeof p.sourceRef === 'string' ? p.sourceRef : '';
    const existing = sourceRef ? findBySourceRef('spots', source, sourceRef) : undefined;
    const localId = existing?.id ?? crypto.randomUUID();
    const goodTimes = parseGoodTimes(p.goodTimes);
    const localPlaceId = p.placeId ? placeIdMap.get(String(p.placeId)) ?? null : null;
    db.handle
      .prepare(
        `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET place_id=excluded.place_id, name=excluded.name, notes=excluded.notes,
           lat=excluded.lat, lng=excluded.lng, tags=excluded.tags, facing_deg=excluded.facing_deg,
           fov_deg=excluded.fov_deg, good_times=excluded.good_times, updated_at=excluded.updated_at`
      )
      .run(
        localId, localPlaceId, ownerId, String(p.name ?? ''), String(p.notes ?? ''), lat, lng,
        JSON.stringify(Array.isArray(p.tags) ? p.tags : []), (typeof p.facingDeg === 'number' ? p.facingDeg : null), (typeof p.fovDeg === 'number' ? p.fovDeg : null),
        JSON.stringify(goodTimes), source, sourceRef, now, now
      );
    spots++;
  }

  return { places, spots };
}

/**
 * Fetch a photo's bytes for `fetchPhoto`, defaulting to a guarded network
 * fetch. Overridable so tests can upsert a bundle without touching the
 * network.
 */
export type PhotoFetcher = (url: string) => Promise<Buffer>;
const defaultFetchPhoto: PhotoFetcher = (url) => guardedFetch(url);

/**
 * Upsert a bundle fetched from a remote into `ownerId`'s rows, tagged
 * `source='remote'`, `source_ref='<remoteId>:<origId>'`. Places are upserted
 * before spots so a spot's `placeId` (the origin instance's id) can be
 * remapped to the local place it was just written as.
 */
export async function upsertBundle(
  db: Db,
  bundle: ShareBundle,
  ownerId: string,
  remoteId: string,
  fetchPhoto: PhotoFetcher = defaultFetchPhoto
): Promise<UpsertResult> {
  const now = new Date().toISOString();
  const result: UpsertResult = { places: 0, spots: 0, sightings: 0 };
  const placeIdMap = new Map<string, string>(); // origin place id -> local place id

  const findBySourceRef = (table: 'places' | 'spots' | 'sightings', sourceRef: string): { id: string } | undefined =>
    db.handle.prepare(`SELECT id FROM ${table} WHERE source = 'remote' AND source_ref = ?`).get(sourceRef) as any;

  for (const f of bundle.features.filter((x) => x.properties.kind === 'place')) {
    const p = f.properties;
    const sourceRef = `${remoteId}:${p.id}`;
    const [lng, lat] = f.geometry.coordinates;
    const existing = findBySourceRef('places', sourceRef);
    const localId = existing?.id ?? crypto.randomUUID();
    placeIdMap.set(String(p.id), localId);
    db.handle
      .prepare(
        `INSERT INTO places (id, owner_id, name, notes, access, lat, lng, geom, visibility, source, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 'remote', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, notes=excluded.notes, access=excluded.access,
           lat=excluded.lat, lng=excluded.lng, geom=excluded.geom, updated_at=excluded.updated_at`
      )
      .run(localId, ownerId, String(p.name ?? ''), String(p.notes ?? ''), String(p.access ?? ''), lat, lng,
        p.geom ? JSON.stringify(p.geom) : null, sourceRef, now, now);
    result.places++;
  }

  for (const f of bundle.features.filter((x) => x.properties.kind === 'spot')) {
    const p = f.properties;
    const sourceRef = `${remoteId}:${p.id}`;
    const [lng, lat] = f.geometry.coordinates;
    const existing = findBySourceRef('spots', sourceRef);
    const localId = existing?.id ?? crypto.randomUUID();
    const goodTimes: GoodTimes = parseGoodTimes(p.goodTimes);
    const localPlaceId = p.placeId ? placeIdMap.get(String(p.placeId)) ?? null : null;
    db.handle
      .prepare(
        `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'remote', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET place_id=excluded.place_id, name=excluded.name, notes=excluded.notes,
           lat=excluded.lat, lng=excluded.lng, tags=excluded.tags, facing_deg=excluded.facing_deg,
           fov_deg=excluded.fov_deg, good_times=excluded.good_times, updated_at=excluded.updated_at`
      )
      .run(
        localId, localPlaceId, ownerId, String(p.name ?? ''), String(p.notes ?? ''), lat, lng,
        JSON.stringify(Array.isArray(p.tags) ? p.tags : []), (typeof p.facingDeg === 'number' ? p.facingDeg : null), (typeof p.fovDeg === 'number' ? p.fovDeg : null),
        JSON.stringify(goodTimes), sourceRef, now, now
      );
    result.spots++;

    // ponytail: photos are only pulled in for a spot upserted for the first
    // time, not re-fetched on every resync. Good enough while photos rarely
    // change after upload; add change detection (an etag/hash) if that stops holding.
    if (!existing && Array.isArray(p.photos)) {
      for (const photo of p.photos as { url: string; thumbUrl: string; kind: string; caption: string; takenAt: string | null }[]) {
        try {
          const fileBuf = await fetchPhoto(photo.url);
          const thumbBuf = await fetchPhoto(photo.thumbUrl);
          const file = saveImage(fileBuf);
          const thumb = saveImage(thumbBuf);
          db.handle
            .prepare('INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, w, h, taken_at, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)')
            .run(crypto.randomUUID(), localId, ownerId, photo.kind ?? 'taken_here', file, thumb, photo.takenAt ?? null, photo.caption ?? '', now);
        } catch {
          // One bad photo shouldn't fail the whole sync.
        }
      }
    }
  }

  for (const f of bundle.features.filter((x) => x.properties.kind === 'sighting')) {
    const p = f.properties;
    const sourceRef = `${remoteId}:${p.id}`;
    const [lng, lat] = f.geometry.coordinates;
    const existing = findBySourceRef('sightings', sourceRef);
    const localId = existing?.id ?? crypto.randomUUID();
    db.handle
      .prepare(
        `INSERT INTO sightings (id, owner_id, kind, direction, lat, lng, line_ref, seen_at, notes, visibility, source, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'remote', ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, direction=excluded.direction, lat=excluded.lat,
           lng=excluded.lng, line_ref=excluded.line_ref, seen_at=excluded.seen_at, notes=excluded.notes`
      )
      .run(localId, ownerId, String(p.sightingKind ?? 'other'), String(p.direction ?? ''), lat, lng,
        String(p.lineRef ?? ''), String(p.seenAt ?? now), String(p.notes ?? ''), sourceRef);
    result.sightings++;
  }

  return result;
}

/** Fetch a remote's share URL and upsert it. The SSRF guard runs inside `guardedFetch`. */
export async function syncRemote(
  db: Db,
  remote: { id: string; owner_id: string; url: string },
  allowPrivateRemotes: boolean
): Promise<UpsertResult> {
  const buf = await guardedFetch(remote.url, allowPrivateRemotes);
  const bundle = JSON.parse(buf.toString('utf8')) as ShareBundle;
  return upsertBundle(db, bundle, remote.owner_id, remote.id);
}

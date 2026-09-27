import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where everything this app keeps on disk lives: database, photos, both. */
export const dataDir = path.resolve(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });
export const photosDir = path.join(dataDir, 'photos');
fs.mkdirSync(photosDir, { recursive: true });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'contributor',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geom TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_owner ON places(owner_id);
CREATE INDEX IF NOT EXISTS idx_places_source ON places(source, source_ref);

CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  place_id TEXT,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  facing_deg REAL,
  fov_deg REAL,
  good_times TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spots_owner ON spots(owner_id);
CREATE INDEX IF NOT EXISTS idx_spots_place ON spots(place_id);
CREATE INDEX IF NOT EXISTS idx_spots_latlng ON spots(lat, lng);
CREATE INDEX IF NOT EXISTS idx_spots_source ON spots(source, source_ref);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'taken_here',
  file TEXT NOT NULL,
  thumb TEXT NOT NULL,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  taken_at TEXT,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_spot ON photos(spot_id);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  UNIQUE(source, ref)
);

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filter TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS remotes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  last_sync TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  line_ref TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sightings_source ON sightings(source, source_ref);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TEXT
);
`;

export interface Db {
  handle: DatabaseSync;
  getKv(key: string): string | null;
  setKv(key: string, value: string, expiresAt?: string | null): void;
}

/**
 * Open (and migrate) a database at `filePath`, or the app's own data dir by
 * default. A path param — `:memory:` in particular — is what lets tests run
 * against a throwaway database instead of the real one.
 */
export function createDb(filePath: string = path.join(dataDir, 'location-scout.db')): Db {
  const handle = new DatabaseSync(filePath, { timeout: 5000 });
  if (filePath !== ':memory:') handle.exec('PRAGMA journal_mode = WAL');
  handle.exec(SCHEMA);

  function getKv(key: string): string | null {
    const row = handle.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as
      { value: string; expires_at: string | null } | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    return row.value;
  }

  function setKv(key: string, value: string, expiresAt: string | null = null): void {
    handle
      .prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
      .run(key, value, expiresAt);
  }

  return { handle, getKv, setKv };
}

/** The app's own database. Tests use `createDb(':memory:')` instead. */
export const db = createDb();

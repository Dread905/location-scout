import { Db } from './db.js';

/** Settings kept in kv, plus what an operator may override from the environment. */
export interface Settings {
  home: { name: string; lat: number; lng: number; radiusKm: number };
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
  allowSignup: boolean;
  /** Lets remotes resolve to a private/loopback/link-local IP. For LAN setups. */
  allowPrivateRemotes: boolean;
  eventScoutUrl: string;
  /** TfNSW Open Data API key. Never sent to clients; env TFNSW_API_KEY wins. */
  tfnswApiKey: string;
  /** Origins allowed to read the open API from a page served elsewhere. */
  corsOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  home: { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100 },
  areas: [],
  allowSignup: false,
  allowPrivateRemotes: false,
  eventScoutUrl: '',
  tfnswApiKey: '',
  corsOrigins: [],
};

export function getSettings(db: Db): Settings {
  const raw = db.getKv('settings');
  const stored = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  // Env wins over what is stored, so an operator can pin these without the UI.
  if (process.env.EVENT_SCOUT_URL) stored.eventScoutUrl = process.env.EVENT_SCOUT_URL;
  if (process.env.TFNSW_API_KEY) stored.tfnswApiKey = process.env.TFNSW_API_KEY;
  delete (stored as Record<string, unknown>).freightSpeedLoadedKmh; // retired with manual sightings
  delete (stored as Record<string, unknown>).freightSpeedEmptyKmh;
  return stored;
}

export function saveSettings(db: Db, settings: Settings): void {
  db.setKv('settings', JSON.stringify(settings));
}

/** The TfNSW API key in effect (env first, then stored), or '' when none. */
export function tfnswKey(db: Db): string {
  return getSettings(db).tfnswApiKey;
}

/** What GET /api/settings returns: everything except the key itself. */
export type PublicSettings = Omit<Settings, 'tfnswApiKey'> & { tfnswApiKeySet: boolean; tfnswApiKeyFromEnv: boolean };

export function publicSettings(settings: Settings): PublicSettings {
  const { tfnswApiKey, ...rest } = settings;
  return { ...rest, tfnswApiKeySet: Boolean(tfnswApiKey), tfnswApiKeyFromEnv: Boolean(process.env.TFNSW_API_KEY) };
}

/**
 * Apply a PUT body. The key is only replaced by a non-empty string, cleared by
 * `clearTfnswApiKey: true`, and otherwise kept. Returns whether it changed.
 */
export function applySettingsUpdate(db: Db, body: Record<string, unknown>): { settings: Settings; keyChanged: boolean } {
  const raw = db.getKv('settings');
  const stored: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  const { tfnswApiKey, clearTfnswApiKey, tfnswApiKeySet: _s, tfnswApiKeyFromEnv: _e, ...rest } = body;
  const next: Settings = { ...stored, ...(rest as Partial<Settings>), tfnswApiKey: stored.tfnswApiKey ?? '' };
  // Don't persist env-pinned values as if the user typed them.
  if (process.env.EVENT_SCOUT_URL) next.eventScoutUrl = stored.eventScoutUrl;
  let keyChanged = false;
  if (clearTfnswApiKey === true) { keyChanged = next.tfnswApiKey !== ''; next.tfnswApiKey = ''; }
  else if (typeof tfnswApiKey === 'string' && tfnswApiKey.trim()) { next.tfnswApiKey = tfnswApiKey.trim(); keyChanged = true; }
  delete (next as unknown as Record<string, unknown>).freightSpeedLoadedKmh;
  delete (next as unknown as Record<string, unknown>).freightSpeedEmptyKmh;
  saveSettings(db, next);
  return { settings: getSettings(db), keyChanged };
}

import { Db } from './db.js';

/** Settings kept in kv, plus what an operator may override from the environment. */
export interface Settings {
  home: { name: string; lat: number; lng: number; radiusKm: number };
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
  allowSignup: boolean;
  /** Lets remotes resolve to a private/loopback/link-local IP. For LAN setups. */
  allowPrivateRemotes: boolean;
  eventScoutUrl: string;
  freightSpeedLoadedKmh: number;
  freightSpeedEmptyKmh: number;
  /** Origins allowed to read the open API from a page served elsewhere. */
  corsOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  home: { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100 },
  areas: [],
  allowSignup: false,
  allowPrivateRemotes: false,
  eventScoutUrl: '',
  freightSpeedLoadedKmh: 60,
  freightSpeedEmptyKmh: 80,
  corsOrigins: [],
};

export function getSettings(db: Db): Settings {
  const raw = db.getKv('settings');
  const stored = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  // Env wins over what is stored, so an operator can pin these without the UI.
  if (process.env.EVENT_SCOUT_URL) stored.eventScoutUrl = process.env.EVENT_SCOUT_URL;
  return stored;
}

export function saveSettings(db: Db, settings: Settings): void {
  db.setKv('settings', JSON.stringify(settings));
}

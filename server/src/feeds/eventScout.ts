/**
 * Event Scout client: nearby events and venue busyness from the user's own
 * event-scout instance, called server-side (so CORS doesn't matter) with
 * private IPs allowed, since event-scout is usually on the LAN.
 */
import { Db } from '../db.js';
import { guardedFetch } from '../ssrf.js';
import { haversine } from '../geo.js';

const CACHE_TTL_MS = 15 * 60_000; // guardedFetch itself times out at 15s

export interface ScoutEvent {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  venueName: string;
  address: string;
  locality: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  category: string;
  [key: string]: unknown;
}

export interface DensityArea { slug: string; name: string; venues: number; withProfile: boolean }
export interface DensityVenue {
  name: string; lat: number; lon: number; live: number | null; typical: number | null; score: number | null;
  observedAt: string | null; busiestDay: string | null; busiestHour: number | null; quietestDay: string | null;
  openDays: string[]; shoot: boolean;
}
export interface DensityHistory { daySummary: { best?: string }[]; now: unknown }

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const buf = await guardedFetch(`${baseUrl.replace(/\/$/, '')}${path}`, true);
  return JSON.parse(buf.toString('utf8')) as T;
}

function cached<T>(db: Db, key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const raw = db.getKv(key);
  if (raw) return Promise.resolve(JSON.parse(raw) as T);
  return fetcher().then((value) => {
    db.setKv(key, JSON.stringify(value), new Date(Date.now() + ttlMs).toISOString());
    return value;
  });
}

// --- events -------------------------------------------------------------------

export async function fetchEvents(baseUrl: string, from: Date, to: Date, limit = 500): Promise<ScoutEvent[]> {
  const path = `/api/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=${limit}`;
  return getJson<ScoutEvent[]>(baseUrl, path);
}

/** Events cached ~15 min, bucketed by the hour so nearby calls share a cache entry. */
export function eventsCached(db: Db, baseUrl: string, days = 7): Promise<ScoutEvent[]> {
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS);
  return cached(db, `eventscout:events:${bucket}`, CACHE_TTL_MS, () => {
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    return fetchEvents(baseUrl, from, to);
  });
}

/** Pure: events within `radiusKm` of a point. */
export function filterEventsNearby(events: ScoutEvent[], lat: number, lng: number, radiusKm = 10): ScoutEvent[] {
  return events.filter((e) => typeof e.lat === 'number' && typeof e.lng === 'number' && haversine(lat, lng, e.lat, e.lng) <= radiusKm * 1000);
}

/** Pure: flag events whose title contains one of the spot's event keywords (case-insensitive). */
export function flagEventKeywords<T extends { title: string }>(events: T[], keywords: string[]): (T & { goodDuring: boolean })[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return events.map((e) => ({ ...e, goodDuring: kws.some((k) => e.title.toLowerCase().includes(k)) }));
}

// --- busyness -------------------------------------------------------------------

export function densityAreasCached(db: Db, baseUrl: string): Promise<{ areas: DensityArea[] }> {
  return cached(db, `eventscout:areas:${baseUrl}`, CACHE_TTL_MS, () => getJson(baseUrl, '/api/density/areas'));
}
export function densityVenuesCached(db: Db, baseUrl: string, slug: string): Promise<DensityVenue[]> {
  return cached(db, `eventscout:venues:${baseUrl}:${slug}`, CACHE_TTL_MS, () => getJson(baseUrl, `/api/density/${encodeURIComponent(slug)}/venues`));
}
export function densityHistoryCached(db: Db, baseUrl: string, slug: string, venue: string, days = 14): Promise<DensityHistory> {
  const path = `/api/density/${encodeURIComponent(slug)}/history?venue=${encodeURIComponent(venue)}&days=${days}`;
  return cached(db, `eventscout:history:${baseUrl}:${slug}:${venue}`, CACHE_TTL_MS, () => getJson(baseUrl, path));
}

/** Pure: nearest venue to a point within `maxKm`, across every area's venue list already fetched. */
export function nearestVenue(areaVenues: { slug: string; venues: DensityVenue[] }[], lat: number, lng: number, maxKm = 2): { slug: string; venue: DensityVenue } | null {
  let best: { slug: string; venue: DensityVenue; km: number } | null = null;
  for (const { slug, venues } of areaVenues) {
    for (const venue of venues) {
      const km = haversine(lat, lng, venue.lat, venue.lon) / 1000;
      if (km <= maxKm && (!best || km < best.km)) best = { slug, venue, km };
    }
  }
  return best ? { slug: best.slug, venue: best.venue } : null;
}

export interface NearbyResult {
  events: (ScoutEvent & { goodDuring: boolean })[];
  crowd: { venue: string; live: number | null; typical: number | null; score: number | null; bestWindow: string | null } | null;
  status: 'ok' | 'not_configured';
}

/** Everything a spot/place panel needs: nearby events (7 days, keyword-flagged) and crowd now vs typical. */
export async function nearbyFor(db: Db, eventScoutUrl: string, lat: number, lng: number, eventKeywords: string[], radiusKm = 10): Promise<NearbyResult> {
  if (!eventScoutUrl) return { events: [], crowd: null, status: 'not_configured' };

  const allEvents = await eventsCached(db, eventScoutUrl);
  const events = flagEventKeywords(filterEventsNearby(allEvents, lat, lng, radiusKm), eventKeywords);

  const { areas } = await densityAreasCached(db, eventScoutUrl);
  const areaVenues = await Promise.all(areas.map(async (a) => ({ slug: a.slug, venues: await densityVenuesCached(db, eventScoutUrl, a.slug) })));
  const nearest = nearestVenue(areaVenues, lat, lng);
  let crowd: NearbyResult['crowd'] = null;
  if (nearest) {
    const history = await densityHistoryCached(db, eventScoutUrl, nearest.slug, nearest.venue.name).catch(() => null);
    crowd = {
      venue: nearest.venue.name, live: nearest.venue.live, typical: nearest.venue.typical, score: nearest.venue.score,
      bestWindow: history?.daySummary?.[0]?.best ?? null,
    };
  }
  return { events, crowd, status: 'ok' };
}

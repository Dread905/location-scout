/** Wikimedia Commons geosearch: photos taken near a spot, for inspiration. Cached 1 day. */
import { Db } from '../db.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'location-scout/0.1 (local personal app)';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 3600_000;

export interface CommonsImage {
  title: string;
  pageUrl: string;
  thumbUrl: string | null;
  lat: number;
  lng: number;
}

interface GeosearchResult { title: string; lat: number; lon: number }
interface ImageInfoPage { title: string; imageinfo?: { thumburl?: string; descriptionurl?: string }[] }

async function commonsFetch(params: Record<string, string>): Promise<any> {
  const url = new URL(COMMONS_API);
  for (const [k, v] of Object.entries({ format: 'json', ...params })) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`Commons returned ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCommonsNearby(lat: number, lng: number, radiusM = 1000, limit = 20): Promise<CommonsImage[]> {
  const geo = await commonsFetch({
    action: 'query', list: 'geosearch', gsnamespace: '6', gscoord: `${lat}|${lng}`, gsradius: String(radiusM), gslimit: String(limit),
  });
  const results = (geo?.query?.geosearch ?? []) as GeosearchResult[];
  if (!results.length) return [];

  const info = await commonsFetch({
    action: 'query', titles: results.map((r) => r.title).join('|'), prop: 'imageinfo', iiprop: 'url', iiurlwidth: '400',
  });
  const pages = Object.values(info?.query?.pages ?? {}) as ImageInfoPage[];
  const thumbByTitle = new Map(pages.map((p) => [p.title, p.imageinfo?.[0]]));

  return results.map((r) => {
    const ii = thumbByTitle.get(r.title);
    return {
      title: r.title.replace(/^File:/, ''),
      pageUrl: ii?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(r.title)}`,
      thumbUrl: ii?.thumburl ?? null,
      lat: r.lat,
      lng: r.lon,
    };
  });
}

const cacheKey = (lat: number, lng: number) => `commons:${lat.toFixed(4)},${lng.toFixed(4)}`;

export async function commonsNearbyCached(db: Db, lat: number, lng: number): Promise<CommonsImage[]> {
  const key = cacheKey(lat, lng);
  const raw = db.getKv(key);
  if (raw) return JSON.parse(raw) as CommonsImage[];
  const images = await fetchCommonsNearby(lat, lng);
  db.setKv(key, JSON.stringify(images), new Date(Date.now() + CACHE_TTL_MS).toISOString());
  return images;
}

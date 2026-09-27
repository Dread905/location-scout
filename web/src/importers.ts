/**
 * Import parsing: every format becomes the FeatureCollection `POST /api/import`
 * takes (Point features with `kind: 'spot'` or `'place'`). The format readers
 * run in the browser; the normalisers below them are pure and node-testable.
 */
import { gpx, kml } from '@tmcw/togeojson';
import { strFromU8, unzipSync } from 'fflate';
import { centroid, haversineKm } from './map/geo.js';

export interface ImportRow {
  kind: 'spot' | 'place';
  name: string;
  lat: number;
  lng: number;
  notes: string;
  geom: GeoJSON.Geometry | null;
  /** Anything else carried over as-is (a Location Scout export keeps its good times, facing, etc). */
  extra: Record<string, unknown>;
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

/** CSV with a header naming at least lat and lng (name and notes optional), or headerless `name,lat,lng,notes`. */
export function csvToRows(text: string): ImportRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = head.includes('lat') || head.includes('latitude');
  const col = (names: string[], fallback: number) => {
    const i = head.findIndex((h) => names.includes(h));
    return hasHeader ? i : fallback;
  };
  const [ni, lai, loi, noi] = [col(['name', 'title'], 0), col(['lat', 'latitude'], 1), col(['lng', 'lon', 'long', 'longitude'], 2), col(['notes', 'description', 'desc'], 3)];
  const out: ImportRow[] = [];
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const lat = Number(r[lai]);
    const lng = Number(r[loi]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || r[lai]?.trim() === '' || r[loi]?.trim() === '') continue;
    out.push({ kind: 'spot', name: (r[ni] ?? '').trim() || 'Unnamed', lat, lng, notes: noi >= 0 ? (r[noi] ?? '').trim() : '', geom: null, extra: {} });
  }
  return out;
}

/** Coordinates out of a Google Maps URL (`?q=lat,lng`, `@lat,lng` or `!3dLAT!4dLNG`). */
function coordsFromMapsUrl(url: string): [number, number] | null {
  const m = url.match(/[?&](?:q|query)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/) ?? url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/)
    ?? url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Any GeoJSON FeatureCollection to import rows: a Location Scout export
 * (properties.kind), Google Takeout Saved Places, or plain GeoJSON / what
 * togeojson made of a GPX, KML or KMZ. Points become spots; lines and
 * polygons become places with that outline.
 */
export function geoJsonToRows(fc: { features?: unknown[] }): ImportRow[] {
  const out: ImportRow[] = [];
  for (const raw of fc.features ?? []) {
    const f = raw as GeoJSON.Feature;
    const p = (f.properties ?? {}) as Record<string, any>;
    const g = f.geometry;
    if (!g) continue;

    if (p.kind === 'spot' || p.kind === 'place') {
      if (g.type !== 'Point') continue;
      const { kind, name, notes, photos: _photos, ...extra } = p;
      out.push({ kind, name: str(name) || 'Unnamed', lat: g.coordinates[1], lng: g.coordinates[0], notes: str(notes), geom: (p.geom as GeoJSON.Geometry) ?? null, extra });
      continue;
    }
    if (p.kind === 'sighting') continue;

    // Takeout: name under location.name / Title / Location["Business Name"]; the point may be 0,0 with coords only in the URL.
    const mapsUrl = str(p.google_maps_url) || str(p['Google Maps URL']);
    const name = str(p.name) || str(p.Title) || str(p.title) || str(p.location?.name) || str(p.Location?.['Business Name'])
      || str(p.location?.address) || str(p.Location?.Address);
    const notes = str(p.desc) || str(p.description) || str(p.notes) || str(p.cmt) || str(p.location?.address) || str(p.Location?.Address);

    if (g.type === 'Point') {
      let [lng, lat] = g.coordinates;
      if (lat === 0 && lng === 0 && mapsUrl) {
        const c = coordsFromMapsUrl(mapsUrl);
        if (!c) continue;
        [lat, lng] = c;
      }
      out.push({ kind: 'spot', name: name || 'Unnamed', lat, lng, notes: notes === name ? '' : notes, geom: null, extra: {} });
    } else if (g.type === 'LineString' || g.type === 'Polygon' || g.type === 'MultiLineString') {
      const line = g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat();
      const geom: GeoJSON.Geometry = g.type === 'MultiLineString' ? { type: 'LineString', coordinates: line } : g;
      const [lng, lat] = centroid(line.map((c) => [c[0], c[1]] as [number, number]));
      out.push({ kind: 'place', name: name || 'Unnamed', lat, lng, notes, geom, extra: {} });
    }
  }
  return out;
}

/** Rows as the FeatureCollection the import endpoint takes. */
export function rowsToFeatureCollection(rows: ImportRow[]) {
  return {
    type: 'FeatureCollection' as const,
    features: rows.map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: { ...r.extra, kind: r.kind, name: r.name, notes: r.notes, ...(r.kind === 'place' ? { geom: r.geom } : {}) },
    })),
  };
}

/** Same name (case-insensitive) within 50 m of something that already exists. */
export function isDuplicate(row: ImportRow, existing: { name: string; lat: number; lng: number }[]): boolean {
  const name = row.name.trim().toLowerCase();
  return existing.some((e) => e.name.trim().toLowerCase() === name && haversineKm(e.lat, e.lng, row.lat, row.lng) <= 0.05);
}

// --- browser-only readers ----------------------------------------------------------------

const xml = (text: string) => new DOMParser().parseFromString(text, 'text/xml');

export async function readImportFile(file: File): Promise<ImportRow[]> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'kmz') {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const name = files['doc.kml'] ? 'doc.kml' : Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'));
    if (!name) throw new Error('No KML inside that KMZ');
    return geoJsonToRows(kml(xml(strFromU8(files[name]))));
  }
  const text = await file.text();
  if (ext === 'gpx') return geoJsonToRows(gpx(xml(text)));
  if (ext === 'kml') return geoJsonToRows(kml(xml(text)));
  if (ext === 'csv') return csvToRows(text);
  if (ext === 'json' || ext === 'geojson') {
    const data = JSON.parse(text);
    if (data?.type !== 'FeatureCollection') throw new Error('Expected a GeoJSON FeatureCollection');
    return geoJsonToRows(data);
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

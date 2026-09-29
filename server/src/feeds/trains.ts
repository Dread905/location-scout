/**
 * TfNSW GTFS trains: static timetables (weekly), realtime vehicle positions
 * and trip updates (cached 20s), and interpolating a position between
 * scheduled stops along the trip's shape. Freight and Indian Pacific trains
 * aren't in this feed — see sources/rail.ts and feeds/freight.ts.
 */
import { strFromU8, unzipSync } from 'fflate';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { Db } from '../db.js';
import { parseCsvObjects } from '../csv.js';
import { Bbox, bboxFromRadius, inBbox } from '../geo.js';
import { projectOntoLine, pointAtDistanceOnLine, LatLng } from './freight.js';
import type { TaskLog } from '../tasks/registry.js';
import { snapToTrack, type TrackGraph } from './trackSnap.js';

export type TrainFeedName = 'nswtrains' | 'sydneytrains';
export const TRAIN_FEEDS: TrainFeedName[] = ['nswtrains', 'sydneytrains'];

const STATIC_URL: Record<TrainFeedName, string> = {
  nswtrains: 'https://api.transport.nsw.gov.au/v1/gtfs/schedule/nswtrains',
  sydneytrains: 'https://api.transport.nsw.gov.au/v1/gtfs/schedule/sydneytrains',
};
// Vehicle positions and trip updates for Sydney Trains moved to v2; NSW Trains stayed on v1.
const VEHICLEPOS_URL: Record<TrainFeedName, string> = {
  nswtrains: 'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/nswtrains',
  sydneytrains: 'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/sydneytrains',
};
const TRIPUPDATE_URL: Record<TrainFeedName, string> = {
  nswtrains: 'https://api.transport.nsw.gov.au/v1/gtfs/realtime/nswtrains',
  sydneytrains: 'https://api.transport.nsw.gov.au/v2/gtfs/realtime/sydneytrains',
};

// --- pure: GTFS time and calendar --------------------------------------------------

/** "HH:MM:SS" (hours may run past 24 for a service continuing past midnight) -> seconds since that service day's midnight. */
export function parseGtfsTime(hhmmss: string): number {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

export interface CalendarRow {
  serviceId: string;
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]; // Monday first, as GTFS calendar.txt orders them
  startDate: string; // YYYYMMDD
  endDate: string; // YYYYMMDD
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** Whether a service runs on a given calendar date. `jsWeekday` is Date#getDay() (0=Sunday). Ignores calendar_dates.txt exceptions. */
export function isServiceActiveOn(cal: CalendarRow, dateYmd: string, jsWeekday: number): boolean {
  if (dateYmd < cal.startDate || dateYmd > cal.endDate) return false;
  return cal.days[(jsWeekday + 6) % 7];
}

// --- pure: the feed shape predictions run against ----------------------------------

export interface GtfsStop extends LatLng { id: string; name: string }
export interface ShapePoint extends LatLng { }
export interface StopTimeRow { stopId: string; seq: number; arrivalSec: number; departureSec: number }
export interface TripRow { id: string; routeId: string; serviceId: string; shapeId: string; headsign: string; feed?: TrainFeedName }
export interface RouteRow { id: string; shortName: string; longName: string }
export interface RealtimeEntry {
  tripId: string; delaySec: number; vehicleLat?: number; vehicleLng?: number;
  /** Realtime compass bearing (degrees) and speed (m/s), when the feed gives them. */
  bearing?: number; speedMps?: number;
  /** Carriage count from GTFS-realtime multi_carriage_details, when present. */
  carriages?: number; feed?: TrainFeedName;
}

export interface TrainsFeedData {
  routes: Map<string, RouteRow>;
  trips: TripRow[];
  stopTimesByTrip: Map<string, StopTimeRow[]>; // sorted by seq
  shapesById: Map<string, ShapePoint[]>;
  stopsById: Map<string, GtfsStop>;
  calendarByService: Map<string, CalendarRow>;
}

export function emptyFeedData(): TrainsFeedData {
  return { routes: new Map(), trips: [], stopTimesByTrip: new Map(), shapesById: new Map(), stopsById: new Map(), calendarByService: new Map() };
}

export function mergeFeedData(a: TrainsFeedData, b: TrainsFeedData): TrainsFeedData {
  return {
    routes: new Map([...a.routes, ...b.routes]),
    trips: [...a.trips, ...b.trips],
    stopTimesByTrip: new Map([...a.stopTimesByTrip, ...b.stopTimesByTrip]),
    shapesById: new Map([...a.shapesById, ...b.shapesById]),
    stopsById: new Map([...a.stopsById, ...b.stopsById]),
    calendarByService: new Map([...a.calendarByService, ...b.calendarByService]),
  };
}

export interface TrainPosition {
  tripId: string; routeId: string; route: string; headsign: string;
  lat: number; lng: number; status: 'live' | 'scheduled'; delaySec: number;
  /** Compass bearing of travel (realtime, else the shape's direction), degrees; null when unknown. */
  bearing: number | null;
  /** Speed along the line, m/s (realtime, else the scheduled segment speed; 0 while dwelling); null when unknown. */
  speedMps: number | null;
  /** Carriages in the consist when the realtime feed says; else null (the client picks a default). */
  carriages: number | null;
  network: TrainFeedName | null;
  /** A slice of the trip's shape around the train ([lng, lat]), for moving it along the track and drawing carriages. */
  path?: [number, number][];
  /** Where the train is along `path`, km from its start. */
  pathAtKm?: number;
  /** True when lat/lng/path were snapped onto OSM track; false means `path` (if any) is the raw GTFS shape. */
  snapped: boolean;
}

// --- pure: a slice of the shape around a train --------------------------------------

const DEG_KM = 111.32;
/** Cumulative km along a [lng, lat] polyline (local equirectangular; fine at rail-corridor scale). */
export function cumulativeKm(coords: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    const [lng0, lat0] = coords[i - 1];
    const [lng1, lat1] = coords[i];
    const k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((lng1 - lng0) * DEG_KM * k, (lat1 - lat0) * DEG_KM));
  }
  return out;
}

/** Compass bearing (degrees) from a to b, [lng, lat]. */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
/** ~0.1 m precision: enough for carriages on a track, without the km offsets drifting off it. */
const roundPath = (p: [number, number][]) => p.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as [number, number]);

/**
 * The part of a polyline from `atKm - backKm` to `atKm + aheadKm` (clamped to the line), with the ends and the
 * train's own point interpolated in; `atKm` is re-based to the slice's start, and `bearing` is the line's direction there.
 */
export function shapeSlice(coords: [number, number][], atKm: number, backKm: number, aheadKm: number): { path: [number, number][]; atKm: number; bearing: number | null } | null {
  if (coords.length < 2) return null;
  const cum = cumulativeKm(coords);
  const total = cum.at(-1)!;
  const at = Math.max(0, Math.min(total, atKm));
  const from = Math.max(0, at - backKm);
  const to = Math.min(total, at + aheadKm);
  const pointAt = (km: number): [number, number] => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < km) i++;
    const t = cum[i] === cum[i - 1] ? 0 : (km - cum[i - 1]) / (cum[i] - cum[i - 1]);
    const [a, b] = [coords[i - 1], coords[i]];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  };
  const path: [number, number][] = [pointAt(from)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > from && cum[i] < to) path.push(coords[i]);
  path.push(pointAt(to));
  // Direction at the train: the segment it sits on (or the last one at the very end).
  let j = 1;
  while (j < cum.length - 1 && cum[j] <= at) j++;
  const bearing = cum[j] > cum[j - 1] ? bearingDeg(coords[j - 1], coords[j]) : null;
  return { path: path.map(([x, y]) => [round5(x), round5(y)] as [number, number]), atKm: at - from, bearing };
}

/** Shape kept behind (for carriages) and ahead (for moving between polls) of each train. */
export const PATH_BACK_KM = 0.6;
export const PATH_AHEAD_KM = 2.5;
/** A live vehicle further than this from its trip's shape isn't given a path. */
const MAX_OFF_SHAPE_KM = 0.3;

function bracket(stopTimes: StopTimeRow[], nowSec: number, delaySec: number): { i: number; frac: number } | null {
  const first = stopTimes[0].departureSec + delaySec;
  const last = stopTimes.at(-1)!.arrivalSec + delaySec;
  if (nowSec < first || nowSec > last) return null;
  for (let i = 1; i < stopTimes.length; i++) {
    const dep = stopTimes[i - 1].departureSec + delaySec;
    const arr = stopTimes[i].arrivalSec + delaySec;
    if (nowSec <= arr) {
      const frac = arr === dep ? 0 : Math.max(0, Math.min(1, (nowSec - dep) / (arr - dep)));
      return { i, frac };
    }
  }
  return null;
}

/**
 * Where every currently-running trip is. A realtime vehicle position wins
 * (status 'live'); otherwise it's interpolated along the trip's shape between
 * the scheduled stops either side of `at`, shifted by any realtime delay.
 * Realtime vehicles with a position but no matching running trip are
 * included too, as 'live'.
 */
export function predictTrainPositions(feed: TrainsFeedData, at: Date, realtime: RealtimeEntry[], track?: TrackGraph | null): TrainPosition[] {
  const rtByTrip = new Map(realtime.map((r) => [r.tripId, r]));
  const out: TrainPosition[] = [];

  for (const trip of feed.trips) {
    const stopTimes = feed.stopTimesByTrip.get(trip.id);
    const shape = feed.shapesById.get(trip.shapeId);
    const cal = feed.calendarByService.get(trip.serviceId);
    if (!stopTimes || stopTimes.length < 2 || !shape || shape.length < 2 || !cal) continue;
    const rt = rtByTrip.get(trip.id);
    const delaySec = rt?.delaySec ?? 0;

    // A service starting before midnight can still be running past it, so
    // also try "yesterday" with nowSec pushed past 24h.
    let br: { i: number; frac: number } | null = null;
    for (const daysAgo of [0, 1]) {
      const day = new Date(at.getTime() - daysAgo * 86_400_000);
      if (!isServiceActiveOn(cal, ymd(day), day.getDay())) continue;
      const nowSec = at.getHours() * 3600 + at.getMinutes() * 60 + at.getSeconds() + daysAgo * 86_400;
      br = bracket(stopTimes, nowSec, delaySec);
      if (br) break;
    }
    if (!br) continue;

    const coords: [number, number][] = shape.map((p) => [p.lng, p.lat]);
    let lat: number; let lng: number; let status: 'live' | 'scheduled' = 'scheduled';
    const stopA = feed.stopsById.get(stopTimes[br.i - 1].stopId);
    const stopB = feed.stopsById.get(stopTimes[br.i].stopId);
    const distA = stopA ? (projectOntoLine(coords, stopA)?.atKm ?? 0) : 0;
    const distB = stopB ? (projectOntoLine(coords, stopB)?.atKm ?? distA) : distA;
    const segSec = stopTimes[br.i].arrivalSec - stopTimes[br.i - 1].departureSec;
    // Scheduled speed over this stop-to-stop run; a train still dwelling (frac 0) is standing.
    let speedMps: number | null = segSec > 0 && br.frac > 0 ? (Math.abs(distB - distA) * 1000) / segSec : segSec > 0 ? 0 : null;
    let atKm: number | null;
    if (rt?.vehicleLat != null && rt?.vehicleLng != null) {
      lat = rt.vehicleLat; lng = rt.vehicleLng; status = 'live';
      const proj = projectOntoLine(coords, { lat, lng });
      atKm = proj && proj.offKm <= MAX_OFF_SHAPE_KM ? proj.atKm : null;
      if (rt.speedMps != null) speedMps = rt.speedMps;
    } else {
      atKm = distA + br.frac * (distB - distA);
      const pos = pointAtDistanceOnLine(coords, atKm);
      lat = pos.lat; lng = pos.lng;
    }
    const slice = atKm != null ? shapeSlice(coords, atKm, PATH_BACK_KM, PATH_AHEAD_KM) : null;
    let bearing = rt?.bearing ?? slice?.bearing ?? null;
    const route = feed.routes.get(trip.routeId);
    let path = slice?.path; let pathAtKm = slice?.atKm;
    // Onto the real rails: the shape's direction there beats a realtime bearing (which can be stale or noisy).
    const snap = track ? snapToTrack(track, [lng, lat], { bearing: slice?.bearing ?? rt?.bearing, shape: slice?.path, backKm: PATH_BACK_KM, aheadKm: PATH_AHEAD_KM }) : null;
    if (snap) { path = roundPath(snap.path); pathAtKm = snap.atKm; lat = snap.lat; lng = snap.lng; bearing = snap.bearing; }
    out.push({
      tripId: trip.id, routeId: trip.routeId, route: route?.shortName ?? route?.longName ?? '', headsign: trip.headsign, lat, lng, status, delaySec,
      bearing, speedMps, carriages: rt?.carriages ?? null, network: trip.feed ?? rt?.feed ?? null, snapped: snap != null,
      ...(path && pathAtKm != null ? { path, pathAtKm } : {}),
    });
  }

  const seen = new Set(out.map((p) => p.tripId));
  const tripsById = new Map(feed.trips.map((t) => [t.id, t]));
  for (const rt of realtime) {
    if (seen.has(rt.tripId) || rt.vehicleLat == null || rt.vehicleLng == null) continue;
    if (!Number.isFinite(rt.vehicleLat) || !Number.isFinite(rt.vehicleLng) || (rt.vehicleLat === 0 && rt.vehicleLng === 0)) continue;
    const trip = tripsById.get(rt.tripId);
    const route = trip ? feed.routes.get(trip.routeId) : undefined;
    // No running trip (so no shape): only the realtime bearing tells the direction on the track.
    const snap = track ? snapToTrack(track, [rt.vehicleLng, rt.vehicleLat], { bearing: rt.bearing, backKm: PATH_BACK_KM, aheadKm: PATH_AHEAD_KM }) : null;
    out.push({
      tripId: rt.tripId, routeId: trip?.routeId ?? '', route: route?.shortName || route?.longName || '', headsign: trip?.headsign ?? '',
      lat: snap?.lat ?? rt.vehicleLat, lng: snap?.lng ?? rt.vehicleLng, status: 'live', delaySec: rt.delaySec,
      bearing: snap?.bearing ?? rt.bearing ?? null, speedMps: rt.speedMps ?? null, carriages: rt.carriages ?? null, network: trip?.feed ?? rt.feed ?? null, snapped: snap != null,
      ...(snap ? { path: roundPath(snap.path), pathAtKm: snap.atKm } : {}),
    });
  }
  return out;
}

export interface TrainPass { tripId: string; routeId: string; route: string; headsign: string; at: Date }
export interface TrainPassResponse { configured: boolean; passes: (Omit<TrainPass, 'at'> & { at: string })[] }

export function clampPassHours(raw: unknown, fallback = 6): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(24, n));
}

export function parsePointPassRequest(query: { lat?: unknown; lng?: unknown; hours?: unknown }):
  | { ok: true; point: LatLng; hours: number }
  | { ok: false; error: string } {
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, error: 'lat and lng are required' };
  }
  return { ok: true, point: { lat, lng }, hours: clampPassHours(query.hours) };
}

/** Trips passing within 2km of `spot` in the next `hours`, by scheduled time (realtime delay isn't projected forward). */
export function nextPasses(feed: TrainsFeedData, spot: LatLng, hours: number, now: Date, maxOffKm = 2): TrainPass[] {
  const out: TrainPass[] = [];
  const dayCount = Math.ceil(hours / 24) + 1;

  for (const trip of feed.trips) {
    const stopTimes = feed.stopTimesByTrip.get(trip.id);
    const shape = feed.shapesById.get(trip.shapeId);
    const cal = feed.calendarByService.get(trip.serviceId);
    if (!stopTimes || stopTimes.length < 2 || !shape || shape.length < 2 || !cal) continue;
    const coords: [number, number][] = shape.map((p) => [p.lng, p.lat]);
    const proj = projectOntoLine(coords, spot);
    if (!proj || proj.offKm > maxOffKm) continue;

    const distances = stopTimes.map((st) => {
      const s = feed.stopsById.get(st.stopId);
      return s ? (projectOntoLine(coords, s)?.atKm ?? 0) : 0;
    });
    let i = 1;
    while (i < distances.length - 1 && distances[i] < proj.atKm) i++;
    const dA = distances[i - 1]; const dB = distances[i];
    const tA = stopTimes[i - 1].departureSec; const tB = stopTimes[i].arrivalSec;
    const frac = dB === dA ? 0 : Math.max(0, Math.min(1, (proj.atKm - dA) / (dB - dA)));
    const passSec = tA + frac * (tB - tA);
    const route = feed.routes.get(trip.routeId);

    for (let d = 0; d < dayCount; d++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      if (!isServiceActiveOn(cal, ymd(day), day.getDay())) continue;
      const at = new Date(day.getTime() + passSec * 1000);
      const hoursFromNow = (at.getTime() - now.getTime()) / 3_600_000;
      if (hoursFromNow >= -1 / 60 && hoursFromNow <= hours) {
        out.push({ tripId: trip.id, routeId: trip.routeId, route: route?.shortName ?? route?.longName ?? '', headsign: trip.headsign, at });
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function buildPointPassesResponse(configured: boolean, feed: TrainsFeedData, point: LatLng, hours: number, now = new Date()): TrainPassResponse {
  if (!configured) return { configured: false, passes: [] };
  const passes = nextPasses(feed, point, clampPassHours(hours), now, 0.15).map((p) => ({ ...p, at: p.at.toISOString() }));
  return { configured: true, passes };
}

// --- impure: fetching, parsing and storing ------------------------------------------

async function fetchWithAuth(url: string, apiKey: string, timeoutMs = 20_000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `apikey ${apiKey}` }, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function parseStaticZip(buf: Buffer) {
  const files = unzipSync(new Uint8Array(buf));
  const read = (name: string) => (files[name] ? parseCsvObjects(strFromU8(files[name])) : []);
  return {
    routes: read('routes.txt'), trips: read('trips.txt'), stopTimes: read('stop_times.txt'),
    stops: read('stops.txt'), shapes: read('shapes.txt'), calendar: read('calendar.txt'),
  };
}

export interface TrainArea { lat: number; lng: number; radiusKm: number }

/** Fetch, filter to trips touching `areas`, and store this feed's static GTFS data, replacing what was there. */
export async function importStaticGtfs(db: Db, feedName: TrainFeedName, apiKey: string, areas: TrainArea[], log: TaskLog): Promise<{ ok: boolean; message: string }> {
  const zip = await fetchWithAuth(STATIC_URL[feedName], apiKey);
  const parsed = parseStaticZip(zip);
  const bboxes: Bbox[] = areas.map((a) => bboxFromRadius(a.lat, a.lng, a.radiusKm));
  const inArea = (lat: number, lng: number) => bboxes.some((b) => inBbox(b, lat, lng));

  const stopsById = new Map(parsed.stops.map((s) => [s.stop_id, { id: s.stop_id, lat: Number(s.stop_lat), lng: Number(s.stop_lon), name: s.stop_name || '' }]));
  const shapePointsById = new Map<string, { seq: number; lat: number; lng: number }[]>();
  for (const row of parsed.shapes) {
    const list = shapePointsById.get(row.shape_id) ?? [];
    list.push({ seq: Number(row.shape_pt_sequence), lat: Number(row.shape_pt_lat), lng: Number(row.shape_pt_lon) });
    shapePointsById.set(row.shape_id, list);
  }
  for (const pts of shapePointsById.values()) pts.sort((a, b) => a.seq - b.seq);

  const stopTimesByTrip = new Map<string, typeof parsed.stopTimes>();
  for (const row of parsed.stopTimes) {
    const list = stopTimesByTrip.get(row.trip_id) ?? [];
    list.push(row);
    stopTimesByTrip.set(row.trip_id, list);
  }
  for (const list of stopTimesByTrip.values()) list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  const touchesArea = (trip: (typeof parsed.trips)[number]): boolean => {
    const shape = shapePointsById.get(trip.shape_id);
    if (shape?.some((p) => inArea(p.lat, p.lng))) return true;
    return (stopTimesByTrip.get(trip.trip_id) ?? []).some((st) => {
      const s = stopsById.get(st.stop_id);
      return s ? inArea(s.lat, s.lng) : false;
    });
  };
  const keptTrips = parsed.trips.filter(touchesArea);
  const keptTripIds = new Set(keptTrips.map((t) => t.trip_id));
  const keptShapeIds = new Set(keptTrips.map((t) => t.shape_id).filter(Boolean));
  const keptServiceIds = new Set(keptTrips.map((t) => t.service_id));
  const keptRouteIds = new Set(keptTrips.map((t) => t.route_id));
  const keptStopIds = new Set([...stopTimesByTrip.entries()].filter(([id]) => keptTripIds.has(id)).flatMap(([, sts]) => sts.map((s) => s.stop_id)));

  db.handle.prepare('DELETE FROM gtfs_routes WHERE feed = ?').run(feedName);
  db.handle.prepare('DELETE FROM gtfs_trips WHERE feed = ?').run(feedName);
  db.handle.prepare('DELETE FROM gtfs_stops WHERE feed = ?').run(feedName);
  db.handle.prepare('DELETE FROM gtfs_stop_times WHERE feed = ?').run(feedName);
  db.handle.prepare('DELETE FROM gtfs_shapes WHERE feed = ?').run(feedName);
  db.handle.prepare('DELETE FROM gtfs_calendar WHERE feed = ?').run(feedName);

  const insRoute = db.handle.prepare('INSERT INTO gtfs_routes (feed, route_id, short_name, long_name) VALUES (?, ?, ?, ?)');
  for (const r of parsed.routes) if (keptRouteIds.has(r.route_id)) insRoute.run(feedName, r.route_id, r.route_short_name || '', r.route_long_name || '');

  const insTrip = db.handle.prepare('INSERT INTO gtfs_trips (feed, trip_id, route_id, service_id, shape_id, headsign) VALUES (?, ?, ?, ?, ?, ?)');
  for (const t of keptTrips) insTrip.run(feedName, t.trip_id, t.route_id, t.service_id, t.shape_id || '', t.trip_headsign || '');

  const insStop = db.handle.prepare('INSERT INTO gtfs_stops (feed, stop_id, name, lat, lng) VALUES (?, ?, ?, ?, ?)');
  for (const id of keptStopIds) { const s = stopsById.get(id); if (s) insStop.run(feedName, s.id, s.name, s.lat, s.lng); }

  const insStopTime = db.handle.prepare('INSERT INTO gtfs_stop_times (feed, trip_id, stop_id, seq, arrival_sec, departure_sec) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [tripId, sts] of stopTimesByTrip) {
    if (!keptTripIds.has(tripId)) continue;
    for (const st of sts) insStopTime.run(feedName, tripId, st.stop_id, Number(st.stop_sequence), parseGtfsTime(st.arrival_time), parseGtfsTime(st.departure_time));
  }

  const insShape = db.handle.prepare('INSERT INTO gtfs_shapes (feed, shape_id, seq, lat, lng) VALUES (?, ?, ?, ?, ?)');
  for (const [shapeId, pts] of shapePointsById) {
    if (!keptShapeIds.has(shapeId)) continue;
    for (const p of pts) insShape.run(feedName, shapeId, p.seq, p.lat, p.lng);
  }

  const insCal = db.handle.prepare('INSERT INTO gtfs_calendar (feed, service_id, days, start_date, end_date) VALUES (?, ?, ?, ?, ?)');
  for (const c of parsed.calendar) {
    if (!keptServiceIds.has(c.service_id)) continue;
    const days = [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].map((v) => (v === '1' ? '1' : '0')).join('');
    insCal.run(feedName, c.service_id, days, c.start_date, c.end_date);
  }

  db.setKv(`trains:lastImport:${feedName}`, new Date().toISOString());
  log(`${feedName}: ${keptTrips.length} of ${parsed.trips.length} trips touch the configured areas`);
  return { ok: true, message: `${keptTrips.length} trips` };
}

/** This feed's static data, in the shape the pure prediction functions take. */
export function loadFeedData(db: Db, feedName: TrainFeedName): TrainsFeedData {
  const data = emptyFeedData();
  for (const r of db.handle.prepare('SELECT * FROM gtfs_routes WHERE feed = ?').all(feedName) as any[]) {
    data.routes.set(r.route_id, { id: r.route_id, shortName: r.short_name, longName: r.long_name });
  }
  for (const t of db.handle.prepare('SELECT * FROM gtfs_trips WHERE feed = ?').all(feedName) as any[]) {
    data.trips.push({ id: t.trip_id, routeId: t.route_id, serviceId: t.service_id, shapeId: t.shape_id, headsign: t.headsign, feed: feedName });
  }
  for (const s of db.handle.prepare('SELECT * FROM gtfs_stops WHERE feed = ?').all(feedName) as any[]) {
    data.stopsById.set(s.stop_id, { id: s.stop_id, name: s.name, lat: s.lat, lng: s.lng });
  }
  for (const st of db.handle.prepare('SELECT * FROM gtfs_stop_times WHERE feed = ? ORDER BY trip_id, seq').all(feedName) as any[]) {
    const list = data.stopTimesByTrip.get(st.trip_id) ?? [];
    list.push({ stopId: st.stop_id, seq: st.seq, arrivalSec: st.arrival_sec, departureSec: st.departure_sec });
    data.stopTimesByTrip.set(st.trip_id, list);
  }
  for (const sh of db.handle.prepare('SELECT * FROM gtfs_shapes WHERE feed = ? ORDER BY shape_id, seq').all(feedName) as any[]) {
    const list = data.shapesById.get(sh.shape_id) ?? [];
    list.push({ lat: sh.lat, lng: sh.lng });
    data.shapesById.set(sh.shape_id, list);
  }
  for (const c of db.handle.prepare('SELECT * FROM gtfs_calendar WHERE feed = ?').all(feedName) as any[]) {
    const days = [...(c.days as string)].map((c2) => c2 === '1') as CalendarRow['days'];
    data.calendarByService.set(c.service_id, { serviceId: c.service_id, days, startDate: c.start_date, endDate: c.end_date });
  }
  return data;
}

export function combinedFeedData(db: Db): TrainsFeedData {
  return TRAIN_FEEDS.map((f) => loadFeedData(db, f)).reduce(mergeFeedData, emptyFeedData());
}

export function tripCount(db: Db): number {
  return (db.handle.prepare('SELECT COUNT(*) AS n FROM gtfs_trips').get() as { n: number }).n;
}

// --- impure: realtime, cached 20s --------------------------------------------------

const realtimeCache = new Map<TrainFeedName, { at: number; entries: RealtimeEntry[] }>();
const REALTIME_TTL_MS = 20_000;

async function fetchRealtimeFeed(feedName: TrainFeedName, apiKey: string): Promise<RealtimeEntry[]> {
  const decode = (buf: Buffer) => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
  const [tu, vp] = await Promise.all([
    fetchWithAuth(TRIPUPDATE_URL[feedName], apiKey).then(decode).catch(() => null),
    fetchWithAuth(VEHICLEPOS_URL[feedName], apiKey).then(decode).catch(() => null),
  ]);
  const byTrip = new Map<string, RealtimeEntry>();
  for (const e of tu?.entity ?? []) {
    const tripId = e.tripUpdate?.trip?.tripId;
    if (!tripId) continue;
    const delaySec = e.tripUpdate?.delay ?? e.tripUpdate?.stopTimeUpdate?.[0]?.arrival?.delay ?? 0;
    byTrip.set(tripId, { tripId, delaySec, feed: feedName });
  }
  for (const e of vp?.entity ?? []) {
    const tripId = e.vehicle?.trip?.tripId;
    if (!tripId) continue;
    const existing = byTrip.get(tripId) ?? { tripId, delaySec: 0, feed: feedName };
    byTrip.set(tripId, { ...existing, vehicleLat: e.vehicle?.position?.latitude, vehicleLng: e.vehicle?.position?.longitude, ...vehicleExtras(e.vehicle) });
  }
  return [...byTrip.values()];
}

/**
 * Bearing, speed and carriage count from a GTFS-realtime VehiclePosition. Protobuf decodes absent floats as 0, so a
 * bearing and speed of exactly 0 together are treated as "not given". TfNSW's own consist extension (field 1007) isn't
 * decoded by gtfs-realtime-bindings; the standard multi_carriage_details is used when a feed fills it in.
 */
export function vehicleExtras(v: { position?: { bearing?: number | null; speed?: number | null } | null; multiCarriageDetails?: unknown[] | null } | null | undefined): Pick<RealtimeEntry, 'bearing' | 'speedMps' | 'carriages'> {
  const out: Pick<RealtimeEntry, 'bearing' | 'speedMps' | 'carriages'> = {};
  const b = v?.position?.bearing;
  const sp = v?.position?.speed;
  const given = !(b === 0 && (sp == null || sp === 0));
  if (typeof b === 'number' && Number.isFinite(b) && given) out.bearing = ((b % 360) + 360) % 360;
  if (typeof sp === 'number' && Number.isFinite(sp) && sp >= 0 && given) out.speedMps = sp;
  const n = v?.multiCarriageDetails?.length ?? 0;
  if (n > 0) out.carriages = n;
  return out;
}

export async function realtimeCached(feedName: TrainFeedName, apiKey: string): Promise<RealtimeEntry[]> {
  const hit = realtimeCache.get(feedName);
  if (hit && Date.now() - hit.at < REALTIME_TTL_MS) return hit.entries;
  try {
    const entries = await fetchRealtimeFeed(feedName, apiKey);
    realtimeCache.set(feedName, { at: Date.now(), entries });
    return entries;
  } catch {
    return hit?.entries ?? []; // stale-if-error rather than a blank map for 20s
  }
}

export async function combinedRealtime(apiKey: string): Promise<RealtimeEntry[]> {
  const lists = await Promise.all(TRAIN_FEEDS.map((f) => realtimeCached(f, apiKey)));
  return lists.flat();
}

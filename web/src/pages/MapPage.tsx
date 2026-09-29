import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GeoJSONSource, LngLatBounds, Map as MlMap, MapMouseEvent, NavigationControl, Popup, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { api, Candidate, Place, Plane, Spot, TrainPosition, User, type WeatherForecast } from '../api.js';
import { hourAt, pickRadarFrame, RAINVIEWER_INDEX, radarTileUrl, weatherIcon, type RadarIndex } from '../map/weather.js';
import {
  CLICKABLE, initFeedLayers, initLayers, PLANE_LAYERS, setImagery, setLayerVisible, setTerrain3d, STYLE_URL, updateCandidates, updateDraft,
  updateMood, updatePlacesAndSpots, updatePlanes, updateRail, updateRays, setNearbyHighlight, updateShadows, updateTrains, updateWedges,
  TRAIN_LAYERS, setTrains3d, updatePlanePositions, hiddenLayers, setRadarFrame,
} from '../map/layers.js';
import { due, MotionTracker, planePredict, trainPredict } from '../map/motion.js';
import { carriageCount } from '../map/trains3d.js';
import { collectRailTiles, RailSnapper } from '../map/railSnap.js';
import { goodNow, sunPos } from '../map/sun.js';
import { Legend } from '../components/Legend.js';
import { NearbyList } from '../components/NearbyList.js';
import { attachGlance, attachThumbLoader, GLANCE_LAYERS } from '../map/spotGlance.js';
import { CATEGORIES, groupLayers, loadVisibility, saveVisibility, type Visibility } from '../map/legend.js';
import { applyBaseRailHighlight, effectiveRailOn, restoreBaseRailHighlight, type BaseRailPaintSnapshot } from '../map/baseRailHighlight.js';
import { buildRailPassPopupHtml, clickableRailLayerIds } from '../map/railPasses.js';
import { deadReckon } from '../map/planes.js';
import { useMapTime } from '../time.js';
import TimeBar from '../components/TimeBar.js';
import SpotPanel from '../components/SpotPanel.js';
import SpotEditor, { SpotDraft } from '../components/SpotEditor.js';
import PlaceEditor, { draftToPlace, PlaceDraft, placeToDraft } from '../components/PlaceEditor.js';
import { emptyGoodTimes } from '../components/GoodTimesEditor.js';
import DayStrip from '../components/DayStrip.js';

type Selection = { type: 'spot' | 'place' | 'candidate'; id: string } | null;
type Editing = { type: 'spot'; draft: SpotDraft } | { type: 'place'; draft: PlaceDraft } | null;
const TRAINS_POLL_MS = 20_000; // matches the server's realtime cache
/** Follow mode re-centres the camera this often, with a linear ease of the same length so the motion is continuous. */
const FOLLOW_EASE_MS = 1000;

type Follow = { kind: 'plane' | 'train'; id: string; name: string; heading: boolean };
const planeName = (p: { flight: string; hex: string }) => p.flight.trim() || p.hex.toUpperCase();
const trainName = (t: { route: string; headsign: string }) => (t.headsign ? `${t.route || 'Train'} → ${t.headsign}` : t.route || 'Train');
/** Same numbers, same prediction: a re-served (cached) poll keeps its animation instead of restarting it. */
const planeKey = (p: Plane) => `${p.lat},${p.lon},${p.track},${p.gs},${p.seen}`;
const trainKey = (t: TrainPosition) => `${t.lat},${t.lng},${t.bearing},${t.speedMps},${t.pathAtKm}`;

export const MAP_CENTRE_KEY = 'ls.mapCentre';

// MapLibre looks for its worker beside its own file, which Vite's bundling moves; hand it Vite's copy.
setWorkerUrl(workerUrl);

const newSpot = (lat: number, lng: number, placeId: string | null = null): SpotDraft => ({
  name: '', notes: '', lat, lng, placeId, tags: [], facingDeg: null, fovDeg: null, goodTimes: emptyGoodTimes(), visibility: 'private',
});

/** Legend keys whose visibility is applied by their own effect below. */
const FEED_KEYS = ['imagery', 'planes', 'rail', 'trains', 'candidates', 'weather'];
const RADAR_POLL_MS = 10 * 60_000;

export default function MapPage({ user }: { user: User | null }) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [mode, setMode] = useState<'browse' | 'pick-spot' | 'draw'>('browse');
  const [terrain, setTerrainOn] = useState(false);
  const [goodOnly, setGoodOnly] = useState(false);
  const [centre, setCentre] = useState({ lat: -33.419, lng: 149.577 });
  const [view, setView] = useState(0); // bumps on moveend, for zoom-scaled geometry and shadows
  const [params, setParams] = useSearchParams();
  const { time } = useMapTime();

  // Phase 3: live feeds, each behind its own toggle so nothing polls unasked.
  // Layer visibility: one source of truth for the legend and the chips.
  const [vis, setVis] = useState<Visibility>(loadVisibility);
  useEffect(() => saveVisibility(vis), [vis]);
  const toggle = (key: string, on = !vis[key]) => setVis((v) => ({ ...v, [key]: on }));
  const { planes: planesOn, rail: railOn, trains: trainsOn, candidates: candidatesOn, imagery, weather: weatherOn } = vis;
  const railEffectiveOn = effectiveRailOn(railOn, trainsOn);
  const baseRailPaint = useRef<BaseRailPaintSnapshot[] | null>(null);
  const [rail, setRail] = useState<GeoJSON.FeatureCollection | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [planeData, setPlaneData] = useState<Plane[]>([]);
  const [trainData, setTrainData] = useState<TrainPosition[]>([]);

  // Smooth movement between polls, and follow mode (camera on one vehicle).
  const planeMotion = useRef(new MotionTracker());
  const trainMotion = useRef(new MotionTracker());
  const railSnapper = useRef(new RailSnapper());
  const planeExtras = useRef<{ sun?: { azimuth: number; altitude: number } }>({});
  const [follow, setFollow] = useState<Follow | null>(null);
  const followRef = useRef<Follow | null>(null);
  followRef.current = follow;
  const [followNote, setFollowNote] = useState('');

  const canEdit = (ownerId: string) => !!user && (user.role === 'admin' || user.id === ownerId);

  const reload = () => Promise.all([api.places(), api.spots()])
    .then(([p, s]) => { setPlaces(p); setSpots(s); })
    .catch((err) => setError((err as Error).message));

  // --- map lifecycle ---
  useEffect(() => {
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: [149.577, -33.419], zoom: 10, maxPitch: 75 });
    m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new ScaleControl({}), 'bottom-left');
    m.once('style.load', () => { initLayers(m); initFeedLayers(m); setMap(m); });
    const onMove = () => {
      const c = m.getCenter();
      setCentre({ lat: c.lat, lng: c.lng });
      setView((v) => v + 1);
      try { localStorage.setItem(MAP_CENTRE_KEY, JSON.stringify({ lat: c.lat, lng: c.lng })); } catch { /* private mode */ }
    };
    m.on('moveend', onMove);
    return () => m.remove();
  }, []);

  useEffect(() => { void reload(); }, []);


  // Start on home, unless a spot or place was asked for in the URL.
  useEffect(() => {
    if (!map || params.get('spot') || params.get('place')) return;
    api.settings().then((s) => map.jumpTo({ center: [s.home.lng, s.home.lat], zoom: 10 })).catch(() => {});
  }, [map]);

  // Rail lines: fetched once for the (toggleable) layer.
  useEffect(() => { api.rail().then(setRail).catch(() => {}); }, []);
  useEffect(() => { if (map) { updateRail(map, rail ?? { type: 'FeatureCollection', features: [] }); setLayerVisible(map, ['rail-lines', 'rail-industrial'], railEffectiveOn); } }, [map, rail, railEffectiveOn]);
  useEffect(() => {
    if (!map) return;
    const restore = () => {
      if (!baseRailPaint.current) return;
      restoreBaseRailHighlight(map, baseRailPaint.current);
      baseRailPaint.current = null;
    };
    const apply = () => {
      restore();
      if (railEffectiveOn) baseRailPaint.current = applyBaseRailHighlight(map);
    };
    apply();
    map.on('style.load', apply);
    return () => {
      map.off('style.load', apply);
      restore();
    };
  }, [map, railEffectiveOn]);

  // Planes: on demand, cached 10s server-side, refreshed every 15s while on and the tab is visible.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, PLANE_LAYERS, planesOn);
    if (!planesOn) { setPlaneData([]); return; }
    let stop = false;
    const tick = () => {
      if (document.hidden) return;
      api.planes(centre.lat, centre.lng, 60).then((planes) => {
        if (stop) return;
        setPlaneData(planes);
        planeMotion.current.update(planes.map((p) => ({ id: p.hex, key: planeKey(p), predict: planePredict(p) })), performance.now());
        const projections = planes.filter((p) => p.track != null && p.gs != null).map((p) => {
          const pts: [number, number][] = [[p.lon, p.lat]];
          for (let m2 = 3; m2 <= 15; m2 += 3) { const d = deadReckon(p, m2); if (d) pts.push([d.lon, d.lat]); }
          return { hex: p.hex, coords: pts };
        });
        const aheadMin = (time.getTime() - Date.now()) / 60_000;
        const ghosts = aheadMin > 0.5 && aheadMin <= 15
          ? planes.map((p) => { const d = deadReckon(p, aheadMin); return d ? { hex: p.hex, lat: d.lat, lon: d.lon } : null; }).filter((g): g is { hex: string; lat: number; lon: number } => g !== null)
          : [];
        planeExtras.current.sun = sunPos(time, centre.lat, centre.lng);
        updatePlanes(map, planes, projections, ghosts, planeExtras.current.sun);
      }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(id); };
  }, [map, planesOn, centre.lat, centre.lng, time]);

  // Trains: live positions *now* (not the slider time), polled while on and the tab is visible.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, TRAIN_LAYERS, trainsOn);
    if (!trainsOn) { trainPopup.current?.remove(); setTrainData([]); return; }
    let stop = false;
    let raw: TrainPosition[] = [];
    // Trains the server couldn't snap go onto the basemap's own rail lines (client fallback; see map/railSnap.ts).
    const show = () => {
      const positions = railSnapper.current.snap(raw);
      trainMotion.current.update(positions.map((t) => ({ id: t.tripId, key: trainKey(t), predict: trainPredict(t) })), performance.now());
      updateTrains(map, positions);
      setTrainData(positions);
    };
    const tick = () => {
      if (document.hidden) return;
      api.trains().then((r) => {
        if (stop) return;
        raw = r.positions;
        railSnapper.current.setTiles(collectRailTiles(map));
        show();
      }).catch(() => {});
    };
    // New basemap tiles: rebuild the rail graph (throttled) and re-snap if it changed and some train needs it.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onSource = (e: { sourceId?: string; isSourceLoaded?: boolean; tile?: unknown }) => {
      if (pending || !e.tile || !raw.some((t) => !t.snapped)) return;
      pending = setTimeout(() => {
        pending = null;
        if (!stop && railSnapper.current.setTiles(collectRailTiles(map))) show();
      }, 1000);
    };
    map.on('sourcedata', onSource);
    tick();
    const id = setInterval(tick, TRAINS_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stop = true; clearInterval(id); if (pending) clearTimeout(pending);
      map.off('sourcedata', onSource); document.removeEventListener('visibilitychange', tick);
    };
  }, [map, trainsOn]);

  // Candidates: OSM points of interest, fetched by bbox while the layer is on.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['candidates'], candidatesOn);
    if (!candidatesOn) return;
    let stop = false;
    const b = map.getBounds();
    api.candidates(`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`).then((c) => { if (!stop) { setCandidates(c); updateCandidates(map, c); } }).catch(() => {});
    return () => { stop = true; };
  }, [map, candidatesOn, view]);

  // Animation: move planes and trains between polls, at most every FRAME_MS, and only for shown layers.
  const trainById = useMemo(() => new Map(trainData.map((t) => [t.tripId, t])), [trainData]);
  const animData = useRef({ planeData, trainData, trainById });
  animData.current = { planeData, trainData, trainById };
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let last = 0;
    let lastCam = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!due(last, now)) return;
      last = now;
      const { planeData: planes, trainData: trains, trainById: byId } = animData.current;
      if (planes.length && !hiddenLayers.has('planes')) {
        updatePlanePositions(map, planes.map((p) => {
          const pose = planeMotion.current.pose(p.hex, now);
          return pose ? { ...p, lat: pose.lat, lon: pose.lng } : p;
        }), planeExtras.current.sun);
      }
      if (trains.length && !hiddenLayers.has('trains')) {
        const moved = trains.map((t) => ({ t, pose: trainMotion.current.pose(t.tripId, now) }));
        updateTrains(map, moved.map(({ t, pose }) => (pose ? { ...t, lat: pose.lat, lng: pose.lng } : t)));
        setTrains3d(moved.map(({ t, pose }) => ({
          id: t.tripId, lng: pose?.lng ?? t.lng, lat: pose?.lat ?? t.lat, bearing: pose?.bearing ?? t.bearing ?? null, live: t.status === 'live',
          carriages: carriageCount(t), ...(pose?.path ? { path: pose.path, pathKm: pose.pathKm } : { path: byId.get(t.tripId)?.path, pathKm: t.pathAtKm }),
        })));
      }
      const f = followRef.current;
      // Not while a finger or button is down: easing the camera would cancel the user's drag before it registers.
      if (f && !pointerDown.current && (now - lastCam >= FOLLOW_EASE_MS || lastCam === 0)) {
        const pose = (f.kind === 'plane' ? planeMotion.current : trainMotion.current).pose(f.id, now + FOLLOW_EASE_MS);
        if (pose) {
          lastCam = now;
          map.easeTo({ center: [pose.lng, pose.lat], ...(f.heading && pose.bearing != null ? { bearing: pose.bearing } : {}),
            duration: FOLLOW_EASE_MS, easing: (x) => x, essential: true });
        }
      }
      if (!f) lastCam = 0;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  // Follow mode: any drag/zoom/rotate/pitch by the user (an event with an originalEvent) hands the camera back.
  const pointerDown = useRef(false);
  useEffect(() => {
    if (!map) return;
    const stopOnGesture = (e: { originalEvent?: Event }) => { if (e.originalEvent && followRef.current) setFollow(null); };
    const evs = ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'wheel'] as const;
    for (const ev of evs) map.on(ev, stopOnGesture);
    const down = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; };
    const downs = ['mousedown', 'touchstart'] as const;
    const ups = ['mouseup', 'touchend', 'touchcancel'] as const;
    for (const ev of downs) map.on(ev, down);
    for (const ev of ups) map.on(ev, up);
    window.addEventListener('mouseup', up);
    return () => {
      for (const ev of evs) map.off(ev, stopOnGesture);
      for (const ev of downs) map.off(ev, down);
      for (const ev of ups) map.off(ev, up);
      window.removeEventListener('mouseup', up);
    };
  }, [map]);

  // A followed vehicle that drops out of its feed (or the feed switched off): say so and stop.
  useEffect(() => {
    if (!follow) return;
    const gone = follow.kind === 'plane' ? !planeData.some((p) => p.hex === follow.id) : !trainData.some((t) => t.tripId === follow.id);
    if (!gone) return;
    setFollow(null);
    setFollowNote(`${follow.name} is no longer in the feed — stopped following`);
  }, [planeData, trainData]);
  useEffect(() => {
    if (!followNote) return;
    const id = setTimeout(() => setFollowNote(''), 5000);
    return () => clearTimeout(id);
  }, [followNote]);

  function startFollow(kind: Follow['kind'], id: string) {
    const name = kind === 'plane'
      ? planeName(planeData.find((p) => p.hex === id) ?? { flight: '', hex: id })
      : trainName(trainData.find((t) => t.tripId === id) ?? { route: '', headsign: '' });
    trainPopup.current?.remove();
    setFollowNote('');
    setFollow({ kind, id, name, heading: false });
  }

  useEffect(() => {
    if (!map) return;
    const spotId = params.get('spot');
    const placeId = params.get('place');
    const s = spotId && spots.find((x) => x.id === spotId);
    const p = placeId && places.find((x) => x.id === placeId);
    if (s) { setSelected({ type: 'spot', id: s.id }); focus(s.lng, s.lat, 15); }
    else if (p) { setSelected({ type: 'place', id: p.id }); fitPlace(p); }
    else return;
    setParams({}, { replace: true });
  }, [map, spots, places]);

  /** Centre a point in the part of the map the panel leaves visible: above the phone sheet, left of the desktop panel. */
  function focus(lng: number, lat: number, zoom?: number) {
    if (!map) return;
    const phone = window.innerWidth <= 820;
    map.easeTo({ center: [lng, lat], zoom, offset: phone ? [0, -map.getContainer().clientHeight * 0.3] : [-200, 0], duration: 500 });
  }

  function fitPlace(p: Place) {
    if (!map) return;
    const pts = [...spots.filter((s) => s.placeId === p.id).map((s) => [s.lng, s.lat]), [p.lng, p.lat]] as [number, number][];
    const flat = (c: unknown): [number, number][] => (typeof (c as unknown[])[0] === 'number' ? [c as [number, number]] : (c as unknown[]).flatMap(flat));
    const g = p.geom as { coordinates?: unknown } | null;
    if (g?.coordinates) pts.push(...flat(g.coordinates));
    const b = pts.reduce((acc, c) => acc.extend(c), new LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: 80, maxZoom: 16, duration: 600 });
  }

  // --- data into the map ---
  const selectedSpot = selected?.type === 'spot' ? spots.find((s) => s.id === selected.id) : undefined;
  const selectedPlace = selected?.type === 'place' ? places.find((p) => p.id === selected.id) : undefined;
  const selectedCandidate = selected?.type === 'candidate' ? candidates.find((c) => c.id === selected.id) : undefined;
  const spotDraft = editing?.type === 'spot' ? editing.draft : null;

  const timeKey = Math.floor(time.getTime() / 300_000); // "good" needn't be redone more often than the slider's step
  /** What's drawn: saved spots with the one being edited swapped for its draft. */
  const shownSpots = useMemo(() => {
    let list = spots;
    if (spotDraft) {
      const d = { ...spotDraft, id: spotDraft.id ?? '__draft', ownerId: '', source: '', sourceRef: '', createdAt: '', updatedAt: '' } as Spot;
      list = spotDraft.id ? spots.map((s) => (s.id === spotDraft.id ? d : s)) : [...spots, d];
    }
    return goodOnly ? list.filter((s) => s.id === '__draft' || s.id === spotDraft?.id || goodNow(s, time)) : list;
  }, [spots, spotDraft, goodOnly, goodOnly ? timeKey : 0]);
  const highlight = spotDraft?.id ?? (spotDraft ? '__draft' : selectedSpot?.id ?? null);
  useEffect(() => {
    if (map) updatePlacesAndSpots(map, places, shownSpots, (s) => goodNow(s, time), highlight);
  }, [map, places, shownSpots, highlight, timeKey]);
  useEffect(() => {
    if (map) updateWedges(map, shownSpots, (s) => goodNow(s, time), highlight);
  }, [view]);

  const origin = spotDraft ?? selectedSpot ?? centre;
  useEffect(() => {
    if (!map) return;
    updateMood(map, sunPos(time, origin.lat, origin.lng));
    updateRays(map, origin, time);
  }, [map, time, origin.lat, origin.lng, view]);

  // Shadows: throttled, on moveend and on time change.
  const shadowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!map) return;
    clearTimeout(shadowTimer.current);
    shadowTimer.current = setTimeout(() => {
      const c = map.getCenter();
      updateShadows(map, sunPos(time, c.lat, c.lng));
    }, 150);
  }, [map, time, view]);
  // Newly loaded building tiles need a pass too, at whatever the time is by then.
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!map) return;
    const onIdle = () => { const c = map.getCenter(); updateShadows(map, sunPos(timeRef.current, c.lat, c.lng)); };
    map.once('idle', onIdle);
    return () => { map.off('idle', onIdle); };
  }, [map, view]);

  useEffect(() => { if (map) setImagery(map, imagery); }, [map, imagery]);

  // Weather: RainViewer radar frames (index refreshed every 10 min) and an Open-Meteo readout for the map centre.
  const [radarIdx, setRadarIdx] = useState<RadarIndex | null>(null);
  useEffect(() => {
    if (!weatherOn) return;
    const load = () => { if (document.visibilityState === 'visible') fetch(RAINVIEWER_INDEX).then((r) => r.json()).then(setRadarIdx).catch(() => {}); };
    load();
    const id = setInterval(load, RADAR_POLL_MS);
    return () => clearInterval(id);
  }, [weatherOn]);
  const radarFrame = radarIdx ? pickRadarFrame(radarIdx, time.getTime()) : null;
  useEffect(() => {
    if (map) setRadarFrame(map, radarIdx && radarFrame ? radarTileUrl(radarIdx.host, radarFrame) : null, !!weatherOn);
  }, [map, weatherOn, radarIdx?.host, radarFrame?.path]);
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  useEffect(() => {
    if (!weatherOn) return;
    const id = setTimeout(() => api.weather(centre.lat, centre.lng).then(setForecast).catch(() => setForecast(null)), 600);
    return () => clearTimeout(id);
  }, [weatherOn, centre.lat, centre.lng]);
  const wxHour = weatherOn ? hourAt(forecast, time.getTime()) : null;
  const wxNight = sunPos(time, centre.lat, centre.lng).altitude < 0;
  // Categories without their own feed effect: apply straight from the legend state.
  useEffect(() => {
    if (!map) return;
    const groups = groupLayers(map.getStyle().layers ?? []);
    for (const c of CATEGORIES) if (!FEED_KEYS.includes(c.key)) setLayerVisible(map, groups[c.key], vis[c.key]);
  }, [map, vis]);
  useEffect(() => { if (map) setTerrain3d(map, terrain); }, [map, terrain]);

  const placeDraft = editing?.type === 'place' ? editing.draft : null;
  useEffect(() => {
    if (map) updateDraft(map, placeDraft?.coords ?? [], placeDraft?.kind ?? 'polygon');
  }, [map, placeDraft]);

  // --- clicks ---
  const onClick = useRef<(e: MapMouseEvent) => void>(() => {});
  onClick.current = (e) => {
    if (!map) return;
    const { lat, lng } = e.lngLat;
    if (mode === 'pick-spot') {
      setMode('browse');
      setSelected(null);
      setEditing({ type: 'spot', draft: newSpot(lat, lng) });
      focus(lng, lat);
      return;
    }
    if (mode === 'draw' && placeDraft) {
      const coords = [...placeDraft.coords, [lng, lat] as [number, number]];
      setEditing({ type: 'place', draft: { ...placeDraft, coords, ...(placeDraft.coords.length ? {} : { lat, lng }) } });
      return;
    }
    if (editing) return;
    const train = map.getLayer('trains') ? map.queryRenderedFeatures(e.point, { layers: ['trains'] })[0] : undefined;
    if (train) return showTrainPopup(map, train, (id) => startFollow('train', id));
    const planeLayers = ['planes', 'planes-label'].filter((l) => map.getLayer(l) && !hiddenLayers.has(l));
    const plane = planeLayers.length ? map.queryRenderedFeatures(e.point, { layers: planeLayers })[0] : undefined;
    const pl = plane && planeData.find((p) => p.hex === plane.properties?.id);
    if (pl) return showPlanePopup(map, pl, (id) => startFollow('plane', id));
    if (trainsOn) {
      const railLayers = clickableRailLayerIds(map.getStyle().layers ?? [], (id) => Boolean(map.getLayer(id)) && !hiddenLayers.has(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      const rail = railLayers.length ? map.queryRenderedFeatures(e.point, { layers: railLayers })[0] : undefined;
      if (rail) return showRailPassPopup(map, lat, lng);
    }
    const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter((l) => map.getLayer(l)) })[0];
    if (!hit) return setSelected(null);
    const id = hit.properties?.id as string;
    if (hit.layer.id === 'clusters') {
      (map.getSource('spots') as GeoJSONSource).getClusterExpansionZoom(hit.properties.cluster_id)
        .then((zoom) => map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom }));
    } else if (GLANCE_LAYERS.includes(hit.layer.id)) {
      // Touch has no hover: the first tap on a spot shows its glance card, the next one selects it.
      if (lastPointer.current === 'touch' && glance.current && glance.current.shownId !== id) {
        glance.current.show(id, (hit.geometry as GeoJSON.Point).coordinates as [number, number]);
        return;
      }
      glance.current?.hide();
      setSelected({ type: 'spot', id });
      const [lng, lat] = (hit.geometry as GeoJSON.Point).coordinates;
      focus(lng, lat);
    } else if (hit.layer.id === 'candidates') {
      setSelected({ type: 'candidate', id });
      const [lng, lat] = (hit.geometry as GeoJSON.Point).coordinates;
      focus(lng, lat);
    } else {
      setSelected({ type: 'place', id });
      const p = places.find((x) => x.id === id);
      if (p && hit.layer.id === 'place-points') fitPlace(p);
    }
  };
  // Spot glance: lazy cover thumbnails and the hover card. Refs keep the handlers on current data.
  const glance = useRef<ReturnType<typeof attachGlance> | null>(null);
  const lastPointer = useRef('mouse');
  const glanceData = useRef<{ spots: Spot[]; time: Date; home: { lat: number; lng: number } | null }>({ spots: [], time, home: null });
  glanceData.current.spots = shownSpots;
  glanceData.current.time = time;
  useEffect(() => {
    if (!map) return;
    const detachThumbs = attachThumbLoader(map);
    const g = attachGlance(map, (id) => glanceData.current.spots.find((s) => s.id === id),
      () => ({ time: glanceData.current.time, home: glanceData.current.home }));
    glance.current = g;
    api.settings().then((s) => { glanceData.current.home = s.home; }).catch(() => {});
    const canvas = map.getCanvas();
    const onPointer = (e: PointerEvent) => { lastPointer.current = e.pointerType; };
    canvas.addEventListener('pointerdown', onPointer);
    return () => { detachThumbs(); g.detach(); glance.current = null; canvas.removeEventListener('pointerdown', onPointer); };
  }, [map]);
  useEffect(() => {
    if (!map) return;
    const click = (e: MapMouseEvent) => onClick.current(e);
    map.on('click', click);
    const pointer = (on: boolean) => () => { map.getCanvas().style.cursor = on ? 'pointer' : ''; };
    for (const l of [...CLICKABLE, 'trains', 'planes']) { map.on('mouseenter', l, pointer(true)); map.on('mouseleave', l, pointer(false)); }
    return () => { map.off('click', click); };
  }, [map]);

  useEffect(() => {
    if (map) map.getCanvas().style.cursor = mode === 'browse' ? '' : 'crosshair';
  }, [map, mode]);

  // --- actions ---
  async function saveSpot(d: SpotDraft) {
    const body = { ...d };
    delete body.id;
    const saved = d.id ? await api.updateSpot(d.id, body) : await api.createSpot(body);
    await reload();
    setEditing(null);
    setSelected({ type: 'spot', id: saved.id });
  }

  async function savePlace(d: PlaceDraft) {
    const body = draftToPlace(d);
    const saved = d.id ? await api.updatePlace(d.id, body) : await api.createPlace(body);
    await reload();
    setMode('browse');
    setEditing(null);
    setSelected({ type: 'place', id: saved.id });
  }

  async function deleteSpot(s: Spot) {
    if (!confirm(`Delete "${s.name}" and its photos?`)) return;
    await api.deleteSpot(s.id);
    setSelected(null);
    await reload();
  }

  async function deletePlace(id: string) {
    if (!confirm('Delete this place? Its spots stay, as standalone spots.')) return;
    await api.deletePlace(id);
    setEditing(null);
    setMode('browse');
    setSelected(null);
    await reload();
  }

  async function createSpotAt(lat: number, lng: number, placeId: string | null = null): Promise<Spot> {
    const s = await api.createSpot({ ...newSpot(lat, lng, placeId), name: 'New spot' });
    await reload();
    setSelected({ type: 'spot', id: s.id });
    focus(lng, lat);
    return s;
  }

  function cancelEdit() {
    setEditing(null);
    setMode('browse');
  }

  async function promoteCandidate(c: Candidate) {
    const spot = await api.promoteCandidate(c.id);
    await reload();
    setSelected({ type: 'spot', id: spot.id });
  }

  const panelOpen = !!editing || !!selectedSpot || !!selectedPlace || !!selectedCandidate;
  const placeSpots = selectedPlace ? spots.filter((s) => s.placeId === selectedPlace.id) : [];

  return (
    <div className={`mapshell${panelOpen ? ' mapshell--panel' : ''}`}>
      <div ref={container} className="mapshell__map" />
      {error && <div className="maptoast error">{error}</div>}
      {follow && (
        <div className="followpill" role="status">
          <span>Following <strong>{follow.name}</strong></span>
          <label title="Turn the map to the vehicle's heading"><input type="checkbox" checked={follow.heading}
            onChange={(e) => setFollow({ ...follow, heading: e.target.checked })} />heading</label>
          <button onClick={() => setFollow(null)} title="Stop following" aria-label="Stop following">✕</button>
        </div>
      )}
      {followNote && !follow && <div className="maptoast">{followNote}</div>}
      {mode !== 'browse' && <div className="maptoast">{mode === 'pick-spot' ? 'Click the map to place the spot' : 'Click the map to add outline points'}</div>}

      <Legend map={map} vis={vis} onToggle={toggle} />
      <NearbyList planes={planesOn ? planeData : null} trains={trainsOn ? trainData : null} centre={centre}
        onHover={(at) => { if (map) setNearbyHighlight(map, at); }}
        following={follow?.id ?? null}
        onFollow={(kind, r) => (follow?.id === r.id ? setFollow(null) : startFollow(kind, r.id))}
        onPlane={(r) => { if (map) map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 11) }); }}
        onTrain={(r) => {
          if (!map) return;
          map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 12) });
          const t = trainData.find((x) => x.tripId === r.id);
          if (t) showTrainPopup(map, { type: 'Feature', properties: { id: t.tripId, route: t.route, headsign: t.headsign, status: t.status, delaySec: t.delaySec }, geometry: { type: 'Point', coordinates: [t.lng, t.lat] } },
            (id) => startFollow('train', id));
        }} />
      <div className="maptools">
        <button className={`chip${goodOnly ? ' active' : ''}`} onClick={() => setGoodOnly(!goodOnly)} title="Only spots whose good times match the map time">Good now</button>
        <button className={`chip${imagery ? ' active' : ''}`} onClick={() => toggle('imagery')}>Satellite</button>
        <button className={`chip${terrain ? ' active' : ''}`} onClick={() => setTerrainOn(!terrain)}>3D</button>
        <button className={`chip${planesOn ? ' active' : ''}`} onClick={() => toggle('planes')} title="Live aircraft, dead-reckoned 15 minutes ahead">✈ Planes</button>
        <button className={`chip${railOn ? ' active' : ''}`} onClick={() => toggle('rail')}>🛤 Rail</button>
        <button className={`chip${trainsOn ? ' active' : ''}`} onClick={() => toggle('trains')} title="Live passenger train positions, refreshed every 20s (needs a TfNSW key)">🚆 Trains</button>
        <button className={`chip${weatherOn ? ' active' : ''}`} onClick={() => toggle('weather')} title="Rain radar (RainViewer, recent past only) and the forecast at the map centre for the map time">🌦 Weather</button>
        <button className={`chip${candidatesOn ? ' active' : ''}`} onClick={() => toggle('candidates')} title="OpenStreetMap viewpoints, ruins and other candidates">📍 Candidates</button>
        {user && !editing && (
          <>
            <button className={`chip${mode === 'pick-spot' ? ' active' : ''}`} onClick={() => setMode(mode === 'pick-spot' ? 'browse' : 'pick-spot')}>+ Spot</button>
            <button className="chip" onClick={() => { setSelected(null); setEditing({ type: 'spot', draft: newSpot(centre.lat, centre.lng) }); }}>+ Spot here</button>
            <button className="chip" onClick={() => {
              setSelected(null);
              setEditing({ type: 'place', draft: { name: '', notes: '', access: '', visibility: 'private', lat: centre.lat, lng: centre.lng, kind: 'polygon', coords: [] } });
              setMode('draw');
            }}>+ Place</button>
          </>
        )}
      </div>

      {panelOpen && (
        <aside className="panel">
          <button className="panel__close" onClick={() => { if (editing) cancelEdit(); else setSelected(null); }} title="Close">✕</button>
          {editing?.type === 'spot' && (
            <SpotEditor key={editing.draft.id ?? 'new'} map={map} draft={editing.draft} places={places}
              onChange={(draft) => setEditing({ type: 'spot', draft })} onSave={() => saveSpot(editing.draft)} onCancel={cancelEdit} />
          )}
          {editing?.type === 'place' && (
            <PlaceEditor draft={editing.draft} drawing={mode === 'draw'} onDrawing={(on) => setMode(on ? 'draw' : 'browse')}
              onChange={(draft) => setEditing({ type: 'place', draft })} onSave={() => savePlace(editing.draft)} onCancel={cancelEdit}
              onDelete={editing.draft.id ? () => void deletePlace(editing.draft.id!) : undefined} />
          )}
          {!editing && selectedSpot && (
            <SpotPanel spot={selectedSpot} place={places.find((p) => p.id === selectedSpot.placeId)} time={time}
              canEdit={canEdit(selectedSpot.ownerId)}
              onEdit={() => { setEditing({ type: 'spot', draft: { ...selectedSpot } }); focus(selectedSpot.lng, selectedSpot.lat); }}
              onDelete={() => void deleteSpot(selectedSpot)}
              onMove={async (lat, lng) => { await api.updateSpot(selectedSpot.id, { lat, lng }); await reload(); focus(lng, lat); }}
              onCreateSpotAt={(lat, lng) => createSpotAt(lat, lng, selectedSpot.placeId)} />
          )}
          {!editing && selectedPlace && (
            <>
              <h2>{selectedPlace.name}</h2>
              <p className="hint">{placeSpots.length} spot{placeSpots.length === 1 ? '' : 's'} · {selectedPlace.visibility}</p>
              {selectedPlace.notes && <p className="panel__notes">{selectedPlace.notes}</p>}
              {selectedPlace.access && <p className="hint">Access: {selectedPlace.access}</p>}
              <DayStrip lat={selectedPlace.lat} lng={selectedPlace.lng} time={time} />
              <ul className="plainlist">
                {placeSpots.map((s) => (
                  <li key={s.id}><button className="linklike" onClick={() => { setSelected({ type: 'spot', id: s.id }); focus(s.lng, s.lat, Math.max(map?.getZoom() ?? 15, 15)); }}>{s.name}</button>
                    {goodNow(s, time) && <span className="badge-good">Good now</span>}</li>
                ))}
              </ul>
              <div className="panel__actions">
                <Link to={`/places/${selectedPlace.id}`}><button>Place page</button></Link>
                {canEdit(selectedPlace.ownerId) && <>
                  <button className="primary" onClick={() => setEditing({ type: 'place', draft: placeToDraft(selectedPlace) })}>Edit</button>
                  <button onClick={() => { setSelected(null); setEditing({ type: 'spot', draft: newSpot(selectedPlace.lat, selectedPlace.lng, selectedPlace.id) }); }}>+ Spot in place</button>
                </>}
              </div>
            </>
          )}
          {!editing && selectedCandidate && (
            <>
              <h2>{selectedCandidate.name || 'Unnamed candidate'}</h2>
              <p className="hint">OpenStreetMap · {selectedCandidate.source}/{selectedCandidate.ref}</p>
              {Object.keys(selectedCandidate.tags).length > 0 && (
                <div className="chiprow">{Object.entries(selectedCandidate.tags).map(([k, v]) => <span key={k} className="chip">{k}={v}</span>)}</div>
              )}
              {user && <div className="panel__actions"><button className="primary" onClick={() => void promoteCandidate(selectedCandidate)}>Promote to spot</button></div>}
            </>
          )}
        </aside>
      )}

      {weatherOn && (
        <div className="wxpill" role="status" title={wxHour ? `Forecast for the map centre at ${new Date(wxHour.time).toLocaleString()} (Open-Meteo)` : undefined}>
          {wxHour ? (<>
            <span className="wxpill__icon">{weatherIcon(wxHour, wxNight)}</span>
            {wxHour.tempC != null && <strong>{Math.round(wxHour.tempC)}°</strong>}
            <span>☁ {wxHour.cloudPct ?? '–'}%</span>
            <span>💧 {wxHour.precipMm ?? 0} mm{wxHour.precipProbPct != null ? ` · ${wxHour.precipProbPct}%` : ''}</span>
            <span>💨 {wxHour.windKmh != null ? Math.round(wxHour.windKmh) : '–'}{wxHour.gustKmh != null ? `–${Math.round(wxHour.gustKmh)}` : ''} km/h</span>
            {wxHour.fogLikely && <span className="wxpill__warn">fog</span>}
          </>) : <span className="wxpill__muted">{forecast ? 'No forecast for this time' : 'Loading weather…'}</span>}
          {!radarFrame && <span className="wxpill__muted" title="RainViewer only has the last ~2 hours">· radar n/a at this time</span>}
          {radarFrame?.nowcast && <span className="wxpill__muted">· radar nowcast</span>}
        </div>
      )}
      <TimeBar lat={origin.lat} lng={origin.lng} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function delayText(sec: number): string {
  const min = Math.round(sec / 60);
  if (min === 0) return 'on time';
  return min > 0 ? `${min} min late` : `${-min} min early`;
}

const trainPopup: { current: Popup | null } = { current: null };

/** A small popup for a train marker: route, headsign, live/estimated and delay, and a Follow button. */
function showTrainPopup(map: MlMap, f: GeoJSON.Feature, onFollow?: (id: string) => void) {
  const p = (f.properties ?? {}) as { id?: string; route?: string; headsign?: string; status?: string; delaySec?: number };
  const live = p.status === 'live';
  const html = `<strong>${escapeHtml(p.route || 'Train')}</strong>${p.headsign ? ` → ${escapeHtml(p.headsign)}` : ''}<br/>`
    + `<span>${live ? '● Live position' : '○ Scheduled estimate'} · ${delayText(Number(p.delaySec ?? 0))}</span>`
    + (onFollow && p.id ? '<br/><button class="popup-follow" type="button">Follow</button>' : '');
  openPopup(map, (f.geometry as GeoJSON.Point).coordinates as [number, number], html, onFollow && p.id ? () => onFollow(p.id!) : undefined);
}

/** Popup for a clicked plane: callsign, type, altitude and speed, and a Follow button. */
function showPlanePopup(map: MlMap, p: Plane, onFollow: (hex: string) => void) {
  const alt = p.alt_baro == null ? '' : p.alt_baro <= 0 ? ' · ground' : ` · ${Math.round((p.alt_baro * 0.3048) / 10) * 10} m`;
  const html = `<strong>${escapeHtml(planeName(p))}</strong>${p.t ? ` <span>${escapeHtml(p.t)}</span>` : ''}<br/>`
    + `<span>${p.gs != null ? `${Math.round(p.gs * 1.852)} km/h` : 'speed –'}${alt}</span>`
    + '<br/><button class="popup-follow" type="button">Follow</button>';
  openPopup(map, [p.lon, p.lat], html, () => onFollow(p.hex));
}

function showRailPassPopup(map: MlMap, lat: number, lng: number) {
  const popup = openPopup(map, [lng, lat], '<div role="status" aria-live="polite"><strong>Passenger trains</strong><br/><span>Loading passes…</span></div>');
  api.trainPassesAt(lat, lng, 6)
    .then((result) => {
      if (trainPopup.current === popup) popup.setHTML(buildRailPassPopupHtml(result));
    })
    .catch((err) => {
      if (trainPopup.current === popup) popup.setHTML(`<div role="alert"><strong>Passenger trains</strong><br/><span>${escapeHtml((err as Error).message)}</span></div>`);
    });
}

function openPopup(map: MlMap, at: [number, number], html: string, onFollow?: () => void) {
  trainPopup.current?.remove();
  const popup = new Popup({ closeButton: true, offset: 10 }).setLngLat(at).setHTML(html).addTo(map);
  popup.getElement()?.querySelector('.popup-follow')?.addEventListener('click', () => { popup.remove(); onFollow?.(); });
  trainPopup.current = popup;
  return popup;
}

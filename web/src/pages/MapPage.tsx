import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GeoJSONSource, LngLatBounds, Map as MlMap, MapMouseEvent, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { api, Candidate, Place, Settings, Sighting, Spot, User } from '../api.js';
import {
  CLICKABLE, initFeedLayers, initLayers, setImagery, setLayerVisible, setTerrain3d, STYLE_URL, updateCandidates, updateDraft,
  updateMood, updatePlacesAndSpots, updatePlanes, updateRail, updateRays, updateShadows, updateSightings, updateTrains, updateWedges,
} from '../map/layers.js';
import { goodNow, sunPos } from '../map/sun.js';
import { deadReckon } from '../map/planes.js';
import { projectAlongLine } from '../map/freightProject.js';
import { useMapTime } from '../time.js';
import TimeBar from '../components/TimeBar.js';
import SpotPanel from '../components/SpotPanel.js';
import SpotEditor, { SpotDraft } from '../components/SpotEditor.js';
import PlaceEditor, { draftToPlace, PlaceDraft, placeToDraft } from '../components/PlaceEditor.js';
import { emptyGoodTimes } from '../components/GoodTimesEditor.js';
import SightingForm, { SightingDraft } from '../components/SightingForm.js';
import DayStrip from '../components/DayStrip.js';

type Selection = { type: 'spot' | 'place' | 'candidate'; id: string } | null;
type Editing = { type: 'spot'; draft: SpotDraft } | { type: 'place'; draft: PlaceDraft } | { type: 'sighting'; draft: SightingDraft } | null;
const RECENT_SIGHTING_MIN = 90;

export const MAP_CENTRE_KEY = 'ls.mapCentre';

// MapLibre looks for its worker beside its own file, which Vite's bundling moves; hand it Vite's copy.
setWorkerUrl(workerUrl);

const newSpot = (lat: number, lng: number, placeId: string | null = null): SpotDraft => ({
  name: '', notes: '', lat, lng, placeId, tags: [], facingDeg: null, fovDeg: null, goodTimes: emptyGoodTimes(), visibility: 'private',
});

export default function MapPage({ user }: { user: User | null }) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [mode, setMode] = useState<'browse' | 'pick-spot' | 'draw'>('browse');
  const [imagery, setImageryOn] = useState(false);
  const [terrain, setTerrainOn] = useState(false);
  const [goodOnly, setGoodOnly] = useState(false);
  const [centre, setCentre] = useState({ lat: -33.419, lng: 149.577 });
  const [view, setView] = useState(0); // bumps on moveend, for zoom-scaled geometry and shadows
  const [params, setParams] = useSearchParams();
  const { time } = useMapTime();

  // Phase 3: live feeds, each behind its own toggle so nothing polls unasked.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [planesOn, setPlanesOn] = useState(false);
  const [railOn, setRailOn] = useState(false);
  const [trainsOn, setTrainsOn] = useState(false);
  const [freightOn, setFreightOn] = useState(false);
  const [candidatesOn, setCandidatesOn] = useState(false);
  const [rail, setRail] = useState<GeoJSON.FeatureCollection | null>(null);
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);

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

  useEffect(() => { api.settings().then(setSettings).catch(() => {}); }, []);

  // Start on home, unless a spot or place was asked for in the URL.
  useEffect(() => {
    if (!map || params.get('spot') || params.get('place')) return;
    api.settings().then((s) => map.jumpTo({ center: [s.home.lng, s.home.lat], zoom: 10 })).catch(() => {});
  }, [map]);

  // Rail lines: fetched once, used both for the (toggleable) layer and for snapping freight ghosts to a line.
  useEffect(() => { api.rail().then(setRail).catch(() => {}); }, []);
  useEffect(() => { if (map) { updateRail(map, rail ?? { type: 'FeatureCollection', features: [] }); setLayerVisible(map, ['rail-lines', 'rail-industrial'], railOn); } }, [map, rail, railOn]);

  // Planes: on demand, cached 10s server-side, refreshed every 15s while on and the tab is visible.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['planes', 'planes-proj', 'planes-ghost'], planesOn);
    if (!planesOn) return;
    let stop = false;
    const tick = () => {
      if (document.hidden) return;
      api.planes(centre.lat, centre.lng, 60).then((planes) => {
        if (stop) return;
        const projections = planes.filter((p) => p.track != null && p.gs != null).map((p) => {
          const pts: [number, number][] = [[p.lon, p.lat]];
          for (let m2 = 3; m2 <= 15; m2 += 3) { const d = deadReckon(p, m2); if (d) pts.push([d.lon, d.lat]); }
          return { hex: p.hex, coords: pts };
        });
        const aheadMin = (time.getTime() - Date.now()) / 60_000;
        const ghosts = aheadMin > 0.5 && aheadMin <= 15
          ? planes.map((p) => { const d = deadReckon(p, aheadMin); return d ? { hex: p.hex, lat: d.lat, lon: d.lon } : null; }).filter((g): g is { hex: string; lat: number; lon: number } => g !== null)
          : [];
        updatePlanes(map, planes, projections, ghosts);
      }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(id); };
  }, [map, planesOn, centre.lat, centre.lng, time]);

  // Trains: predicted positions at map time, refetched whenever the time slider moves.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['trains'], trainsOn);
    if (!trainsOn) return;
    let stop = false;
    api.trains(time).then((r) => { if (!stop) updateTrains(map, r.positions); }).catch(() => {});
    return () => { stop = true; };
  }, [map, trainsOn, time]);

  // Freight sightings + ghosts: fetched around the map view, ghosts recomputed locally as the slider moves.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['sightings', 'sightings-ghost'], freightOn);
    if (!freightOn) return;
    let stop = false;
    api.sightings({ near: `${centre.lat},${centre.lng}`, radiusKm: 40 }).then((s) => { if (!stop) setSightings(s); }).catch(() => {});
    return () => { stop = true; };
  }, [map, freightOn, centre.lat, centre.lng, view]);

  useEffect(() => {
    if (!map || !freightOn) return;
    const lines = (rail?.features ?? []).filter((f): f is GeoJSON.Feature<GeoJSON.LineString> => f.geometry?.type === 'LineString');
    const byRef = new Map(lines.map((f) => [String(f.properties?.id ?? ''), f.geometry.coordinates as [number, number][]]));
    const now = Date.now();
    const ghosts: { id: string; kind: string; lat: number; lng: number }[] = [];
    for (const s of sightings) {
      const seenAt = new Date(s.seenAt).getTime();
      if (!Number.isFinite(seenAt) || (now - seenAt) / 60_000 > RECENT_SIGHTING_MIN) continue;
      const coords = s.lineRef ? byRef.get(s.lineRef) : undefined;
      if (!coords) continue;
      const elapsedMin = Math.max(0, Math.min(RECENT_SIGHTING_MIN, (time.getTime() - seenAt) / 60_000));
      const speed = s.loaded === false ? (settings?.freightSpeedEmptyKmh ?? 80) : (settings?.freightSpeedLoadedKmh ?? 60);
      const pos = projectAlongLine(coords, s, s.direction, speed, elapsedMin);
      if (pos) ghosts.push({ id: s.id, kind: s.kind, lat: pos.lat, lng: pos.lng });
    }
    updateSightings(map, sightings, ghosts);
  }, [map, freightOn, sightings, rail, time, settings]);

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
    const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter((l) => map.getLayer(l)) })[0];
    if (!hit) return setSelected(null);
    const id = hit.properties?.id as string;
    if (hit.layer.id === 'clusters') {
      (map.getSource('spots') as GeoJSONSource).getClusterExpansionZoom(hit.properties.cluster_id)
        .then((zoom) => map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom }));
    } else if (hit.layer.id === 'spot-points' || hit.layer.id === 'place-spots') {
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
  useEffect(() => {
    if (!map) return;
    const click = (e: MapMouseEvent) => onClick.current(e);
    map.on('click', click);
    const pointer = (on: boolean) => () => { map.getCanvas().style.cursor = on ? 'pointer' : ''; };
    for (const l of CLICKABLE) { map.on('mouseenter', l, pointer(true)); map.on('mouseleave', l, pointer(false)); }
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

  async function saveSighting(d: SightingDraft) {
    await api.createSighting({ ...d, seenAt: new Date().toISOString() });
    setEditing(null);
    if (freightOn) api.sightings({ near: `${centre.lat},${centre.lng}`, radiusKm: 40 }).then(setSightings).catch(() => {});
  }

  function logSightingHere() {
    const draft: SightingDraft = { kind: 'coal', direction: 'up', lat: centre.lat, lng: centre.lng, notes: '', loaded: null, visibility: 'private' };
    setSelected(null);
    setEditing({ type: 'sighting', draft }); // opens at the map centre immediately; geolocation refines it if it answers in time
    navigator.geolocation?.getCurrentPosition(
      (pos) => setEditing((prev) => (prev?.type === 'sighting' ? { type: 'sighting', draft: { ...prev.draft, lat: pos.coords.latitude, lng: pos.coords.longitude } } : prev)),
      () => {},
      { timeout: 4000 }
    );
  }

  const panelOpen = !!editing || !!selectedSpot || !!selectedPlace || !!selectedCandidate;
  const placeSpots = selectedPlace ? spots.filter((s) => s.placeId === selectedPlace.id) : [];

  return (
    <div className="mapshell">
      <div ref={container} className="mapshell__map" />
      {error && <div className="maptoast error">{error}</div>}
      {mode !== 'browse' && <div className="maptoast">{mode === 'pick-spot' ? 'Click the map to place the spot' : 'Click the map to add outline points'}</div>}

      <div className="maptools">
        <button className={`chip${goodOnly ? ' active' : ''}`} onClick={() => setGoodOnly(!goodOnly)} title="Only spots whose good times match the map time">Good now</button>
        <button className={`chip${imagery ? ' active' : ''}`} onClick={() => setImageryOn(!imagery)}>Satellite</button>
        <button className={`chip${terrain ? ' active' : ''}`} onClick={() => setTerrainOn(!terrain)}>3D</button>
        <button className={`chip${planesOn ? ' active' : ''}`} onClick={() => setPlanesOn(!planesOn)} title="Live aircraft, dead-reckoned 15 minutes ahead">✈ Planes</button>
        <button className={`chip${railOn ? ' active' : ''}`} onClick={() => setRailOn(!railOn)}>🛤 Rail</button>
        <button className={`chip${trainsOn ? ' active' : ''}`} onClick={() => setTrainsOn(!trainsOn)} title="Passenger trains at map time (needs a TfNSW key)">🚆 Trains</button>
        <button className={`chip${freightOn ? ' active' : ''}`} onClick={() => setFreightOn(!freightOn)} title="Logged coal/freight sightings and their projected ghosts">🚂 Freight</button>
        <button className={`chip${candidatesOn ? ' active' : ''}`} onClick={() => setCandidatesOn(!candidatesOn)} title="OpenStreetMap viewpoints, ruins and other candidates">📍 Candidates</button>
        {user && !editing && <button className="chip" onClick={logSightingHere}>🚂 Train seen</button>}
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
          {editing?.type === 'sighting' && (
            <SightingForm draft={editing.draft} onChange={(draft) => setEditing({ type: 'sighting', draft })}
              onSave={() => void saveSighting(editing.draft)} onCancel={cancelEdit} />
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

      <TimeBar lat={origin.lat} lng={origin.lng} />
    </div>
  );
}

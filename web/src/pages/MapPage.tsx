import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GeoJSONSource, LngLatBounds, Map as MlMap, MapMouseEvent, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { api, Place, Spot, User } from '../api.js';
import {
  CLICKABLE, initLayers, setImagery, setTerrain3d, STYLE_URL, updateDraft, updateMood,
  updatePlacesAndSpots, updateRays, updateShadows, updateWedges,
} from '../map/layers.js';
import { goodNow, sunPos } from '../map/sun.js';
import { useMapTime } from '../time.js';
import TimeBar from '../components/TimeBar.js';
import SpotPanel from '../components/SpotPanel.js';
import SpotEditor, { SpotDraft } from '../components/SpotEditor.js';
import PlaceEditor, { draftToPlace, PlaceDraft, placeToDraft } from '../components/PlaceEditor.js';
import { emptyGoodTimes } from '../components/GoodTimesEditor.js';
import DayStrip from '../components/DayStrip.js';

type Selection = { type: 'spot' | 'place'; id: string } | null;
type Editing = { type: 'spot'; draft: SpotDraft } | { type: 'place'; draft: PlaceDraft } | null;

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

  const canEdit = (ownerId: string) => !!user && (user.role === 'admin' || user.id === ownerId);

  const reload = () => Promise.all([api.places(), api.spots()])
    .then(([p, s]) => { setPlaces(p); setSpots(s); })
    .catch((err) => setError((err as Error).message));

  // --- map lifecycle ---
  useEffect(() => {
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: [149.577, -33.419], zoom: 10, maxPitch: 75 });
    m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new ScaleControl({}), 'bottom-left');
    m.once('style.load', () => { initLayers(m); setMap(m); });
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

  const panelOpen = !!editing || !!selectedSpot || !!selectedPlace;
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
        </aside>
      )}

      <TimeBar lat={origin.lat} lng={origin.lng} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, Marker } from 'maplibre-gl';
import type { Place, Spot, Visibility } from '../api.js';
import { bearing, destination } from '../map/geo.js';
import { metresPerPixel } from '../map/layers.js';
import GoodTimesEditor from './GoodTimesEditor.js';

export type SpotDraft = Omit<Spot, 'id' | 'ownerId' | 'source' | 'sourceRef' | 'createdAt' | 'updatedAt'> & { id?: string };

/**
 * Spot form, plus two map handles: the spot itself (drag to move) and a
 * facing handle (drag around the spot to aim it).
 */
export default function SpotEditor({ map, draft, places, onChange, onSave, onCancel }: {
  map: MlMap | null;
  draft: SpotDraft;
  places: Place[];
  onChange: (d: SpotDraft) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState(draft.tags.join(', '));
  const latest = useRef({ draft, onChange });
  latest.current = { draft, onChange };
  const markers = useRef<{ pos: Marker; handle: Marker; dragging: boolean } | null>(null);

  const handleAt = (d: SpotDraft) => (map ? destination(d.lat, d.lng, d.facingDeg ?? 0, (metresPerPixel(map) * 70) / 1000) : [d.lng, d.lat] as [number, number]);

  useEffect(() => {
    if (!map) return;
    const d = latest.current.draft;
    const pos = new Marker({ draggable: true, color: '#f5a623' }).setLngLat([d.lng, d.lat]).addTo(map);
    const el = document.createElement('div');
    el.className = 'facing-handle';
    el.title = 'Drag to aim';
    const handle = new Marker({ element: el, draggable: true }).setLngLat(handleAt(d)).addTo(map);
    const m = { pos, handle, dragging: false };
    markers.current = m;
    const change = (patch: Partial<SpotDraft>) => latest.current.onChange({ ...latest.current.draft, ...patch });
    pos.on('drag', () => { const ll = pos.getLngLat(); change({ lat: ll.lat, lng: ll.lng }); });
    handle.on('dragstart', () => { m.dragging = true; });
    handle.on('drag', () => {
      const ll = handle.getLngLat();
      const cur = latest.current.draft;
      change({ facingDeg: Math.round(bearing(cur.lat, cur.lng, ll.lat, ll.lng)) % 360 });
    });
    handle.on('dragend', () => { m.dragging = false; handle.setLngLat(handleAt(latest.current.draft)); });
    const onZoom = () => handle.setLngLat(handleAt(latest.current.draft));
    map.on('zoomend', onZoom);
    return () => { pos.remove(); handle.remove(); map.off('zoomend', onZoom); markers.current = null; };
  }, [map]);

  useEffect(() => {
    const m = markers.current;
    if (!m) return;
    m.pos.setLngLat([draft.lng, draft.lat]);
    if (!m.dragging) m.handle.setLngLat(handleAt(draft));
    m.handle.getElement().classList.toggle('facing-handle--unset', draft.facingDeg == null);
  }, [draft.lat, draft.lng, draft.facingDeg]);

  const set = (patch: Partial<SpotDraft>) => onChange({ ...draft, ...patch });

  async function save() {
    setError('');
    if (!draft.name.trim()) return setError('Name is required');
    setBusy(true);
    try {
      await onSave();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{draft.id ? 'Edit spot' : 'New spot'}</h2>
      <p className="hint">Drag the orange pin to move it, and the ring handle to aim it.</p>
      <label>Name<input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
      <label>Place
        <select value={draft.placeId ?? ''} onChange={(e) => set({ placeId: e.target.value || null })}>
          <option value="">None (standalone)</option>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="editor-form__row">
        <label>Facing °
          <input type="number" min={0} max={359} value={draft.facingDeg ?? ''} placeholder="none"
            onChange={(e) => set({ facingDeg: e.target.value === '' ? null : ((Number(e.target.value) % 360) + 360) % 360 })} />
        </label>
        <label>FOV °
          <input type="number" min={5} max={180} value={draft.fovDeg ?? ''} placeholder="60"
            onChange={(e) => set({ fovDeg: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
        <label>Visibility
          <select value={draft.visibility} onChange={(e) => set({ visibility: e.target.value as Visibility })}>
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
      </div>
      <label>Tags<input value={tags} placeholder="comma, separated" onChange={(e) => {
        setTags(e.target.value);
        set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) });
      }} /></label>
      <label>Notes<textarea rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      <p className="hint">{draft.lat.toFixed(5)}, {draft.lng.toFixed(5)}</p>

      <h4>Good times</h4>
      <GoodTimesEditor value={draft.goodTimes} onChange={(goodTimes) => set({ goodTimes })} />

      {error && <p className="status-line error">{error}</p>}
      <div className="panel__actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

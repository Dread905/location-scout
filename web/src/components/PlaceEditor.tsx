import { useState } from 'react';
import type { Place, Visibility } from '../api.js';
import { centroid } from '../map/geo.js';

export interface PlaceDraft {
  id?: string;
  name: string;
  notes: string;
  access: string;
  visibility: Visibility;
  lat: number;
  lng: number;
  kind: 'polygon' | 'line';
  coords: [number, number][];
}

export function placeToDraft(p: Place): PlaceDraft {
  const g = p.geom as GeoJSON.Polygon | GeoJSON.LineString | null;
  const coords = (g?.type === 'Polygon' ? g.coordinates[0].slice(0, -1) : g?.type === 'LineString' ? g.coordinates : []) as [number, number][];
  return { id: p.id, name: p.name, notes: p.notes, access: p.access, visibility: p.visibility, lat: p.lat, lng: p.lng, kind: g?.type === 'LineString' ? 'line' : 'polygon', coords };
}

/** The API body for a draft: the outline as GeoJSON, centred on its vertices. */
export function draftToPlace(d: PlaceDraft): Partial<Place> {
  const geom = d.kind === 'polygon' && d.coords.length >= 3 ? { type: 'Polygon', coordinates: [[...d.coords, d.coords[0]]] }
    : d.coords.length >= 2 ? { type: 'LineString', coordinates: d.coords } : null;
  const [lng, lat] = d.coords.length ? centroid(d.coords) : [d.lng, d.lat];
  return { name: d.name.trim(), notes: d.notes, access: d.access, visibility: d.visibility, lat, lng, geom };
}

/** Place form. The outline is edited by clicking and dragging on the map while `drawing` is on; no draw library. */
export default function PlaceEditor({ draft, drawing, onDrawing, onChange, onSave, onCancel, onDelete }: {
  draft: PlaceDraft;
  drawing: boolean;
  onDrawing: (on: boolean) => void;
  onChange: (d: PlaceDraft) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PlaceDraft>) => onChange({ ...draft, ...patch });

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
      <h2>{draft.id ? 'Edit place' : 'New place'}</h2>
      <label>Name<input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>

      <h4>Outline</h4>
      <div className="seg">
        <button type="button" className={draft.kind === 'polygon' ? 'active' : ''} onClick={() => set({ kind: 'polygon' })}>Area</button>
        <button type="button" className={draft.kind === 'line' ? 'active' : ''} onClick={() => set({ kind: 'line' })}>Line (track)</button>
      </div>
      <div className="chiprow mt-8">
        <button type="button" className={drawing ? 'primary' : ''} onClick={() => onDrawing(!drawing)}>{drawing ? 'Done editing' : 'Edit on map'}</button>
        <button type="button" disabled={!draft.coords.length} onClick={() => set({ coords: draft.coords.slice(0, -1) })}>Undo point</button>
        <button type="button" disabled={!draft.coords.length} onClick={() => set({ coords: [] })}>Clear</button>
      </div>
      <p className="hint">{drawing ? 'Click to add points, click a segment to insert one, or drag a handle to move a point.' : `${draft.coords.length} points.`} No outline is fine too: the place then sits where you first clicked.</p>

      <label>Access<textarea rows={2} value={draft.access} placeholder="Parking, gates, opening hours…" onChange={(e) => set({ access: e.target.value })} /></label>
      <label>Notes<textarea rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      <label>Visibility
        <select value={draft.visibility} onChange={(e) => set({ visibility: e.target.value as Visibility })}>
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </select>
      </label>

      {error && <p className="status-line error">{error}</p>}
      <div className="panel__actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {onDelete && <button type="button" onClick={onDelete}>Delete</button>}
      </div>
    </form>
  );
}

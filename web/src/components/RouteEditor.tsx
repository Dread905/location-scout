import { useState } from 'react';
import type { Route, RouteType, Visibility } from '../api.js';

export interface RouteDraft {
  id?: string;
  name: string;
  notes: string;
  access: string;
  type: RouteType;
  vertices: [number, number][];
  staging: { lat: number; lng: number } | null;
  visibility: Visibility;
}

export function routeToDraft(r: Route): RouteDraft {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes,
    access: r.access,
    type: r.type,
    vertices: r.vertices.slice(),
    staging: r.staging ? { ...r.staging } : null,
    visibility: r.visibility,
  };
}

export function blankRouteDraft(): RouteDraft {
  return { name: '', notes: '', access: '', type: 'sprint', vertices: [], staging: null, visibility: 'private' };
}

/** The API body for saving a draft. */
export function draftToRoute(d: RouteDraft): Partial<Route> {
  return {
    name: d.name.trim(),
    notes: d.notes,
    access: d.access,
    type: d.type,
    vertices: d.vertices,
    staging: d.staging ?? null,
    visibility: d.visibility,
  };
}

/**
 * Route editor form.
 *
 * Vertex drawing (click-to-add, drag-to-move, click-segment-to-insert, undo, clear)
 * is driven by the parent MapPage via the `drawing` / `onDrawing` interaction — the
 * same mechanism used by PlaceEditor, reusing PlaceOutlineVertexMarkers with kind='line'.
 *
 * Staging location is set by clicking the map while stagingMode is on.
 */
export default function RouteEditor({
  draft,
  drawing,
  stagingMode,
  onDrawing,
  onStagingMode,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: RouteDraft;
  drawing: boolean;
  stagingMode: boolean;
  onDrawing: (on: boolean) => void;
  onStagingMode: (on: boolean) => void;
  onChange: (d: RouteDraft) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<RouteDraft>) => onChange({ ...draft, ...patch });

  async function save() {
    setError('');
    if (!draft.name.trim()) return setError('Name is required');
    if (draft.vertices.length < 2) return setError('A route needs at least 2 points');
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
      <h2>{draft.id ? 'Edit route' : 'New route'}</h2>

      <label>Name<input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>

      <h4>Type</h4>
      <div className="seg">
        <button type="button" className={draft.type === 'sprint' ? 'active' : ''} onClick={() => set({ type: 'sprint' })}>Sprint</button>
        <button type="button" className={draft.type === 'circuit' ? 'active' : ''} onClick={() => set({ type: 'circuit' })}>Circuit</button>
      </div>
      <p className="hint">{draft.type === 'circuit' ? 'Circuit: last point links back to first.' : 'Sprint: ends at the final point.'}</p>

      <h4>Route points</h4>
      <div className="chiprow mt-8">
        <button type="button" className={drawing ? 'primary' : ''} onClick={() => { onDrawing(!drawing); if (stagingMode) onStagingMode(false); }}>
          {drawing ? 'Done editing' : 'Edit on map'}
        </button>
        <button type="button" disabled={!draft.vertices.length} onClick={() => set({ vertices: draft.vertices.slice(0, -1) })}>Undo point</button>
        <button type="button" disabled={!draft.vertices.length} onClick={() => set({ vertices: [] })}>Clear</button>
      </div>
      <p className="hint">
        {drawing
          ? 'Click to add points, click a segment to insert one, or drag a handle to move a point.'
          : `${draft.vertices.length} point${draft.vertices.length !== 1 ? 's' : ''}.`}
      </p>

      <h4>Staging location</h4>
      <div className="chiprow mt-8">
        <button type="button" className={stagingMode ? 'primary' : ''} onClick={() => { onStagingMode(!stagingMode); if (drawing) onDrawing(false); }}>
          {stagingMode ? 'Done — click map' : draft.staging ? 'Move staging' : 'Set staging'}
        </button>
        {draft.staging && (
          <button type="button" onClick={() => set({ staging: null })}>Clear staging</button>
        )}
      </div>
      {draft.staging
        ? <p className="hint">Staging: {draft.staging.lat.toFixed(5)}, {draft.staging.lng.toFixed(5)} — used as planning anchor in Plan Shoot.</p>
        : <p className="hint">Optional. When set, Plan Shoot uses this as the anchor instead of the first point.</p>}

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

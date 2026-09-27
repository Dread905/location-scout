import type { SightingKind } from '../api.js';

export interface SightingDraft {
  kind: SightingKind;
  direction: string; // 'up' | 'down' | a free bearing
  lat: number;
  lng: number;
  notes: string;
  loaded: boolean | null;
  visibility: 'private' | 'unlisted' | 'public';
}

const KINDS: SightingKind[] = ['coal', 'grain', 'intermodal', 'other'];

/** The one-tap "train seen" quick form: kind, direction and loaded, nothing else required. */
export default function SightingForm({ draft, onChange, onSave, onCancel }: {
  draft: SightingDraft;
  onChange: (d: SightingDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<SightingDraft>) => onChange({ ...draft, ...patch });

  return (
    <>
      <h2>🚂 Train seen</h2>
      <p className="hint">{draft.lat.toFixed(4)}, {draft.lng.toFixed(4)} — snapped to the nearest rail line on save.</p>

      <label className="gt__label">Kind</label>
      <div className="chiprow">
        {KINDS.map((k) => <button key={k} type="button" className={`chip${draft.kind === k ? ' active' : ''}`} onClick={() => set({ kind: k })}>{k}</button>)}
      </div>

      <label className="gt__label">Direction</label>
      <div className="seg">
        <button type="button" className={draft.direction === 'up' ? 'active' : ''} onClick={() => set({ direction: 'up' })}>Up the line</button>
        <button type="button" className={draft.direction === 'down' ? 'active' : ''} onClick={() => set({ direction: 'down' })}>Down the line</button>
      </div>
      <input placeholder="Or a compass bearing, e.g. 045" value={['up', 'down'].includes(draft.direction) ? '' : draft.direction}
        onChange={(e) => set({ direction: e.target.value })} style={{ marginTop: 6 }} />

      <label className="gt__label">Loaded (heading to port)?</label>
      <div className="seg">
        <button type="button" className={draft.loaded === true ? 'active' : ''} onClick={() => set({ loaded: true })}>Loaded</button>
        <button type="button" className={draft.loaded === false ? 'active' : ''} onClick={() => set({ loaded: false })}>Empty</button>
        <button type="button" className={draft.loaded === null ? 'active' : ''} onClick={() => set({ loaded: null })}>Unsure</button>
      </div>

      <label className="gt__label">Notes</label>
      <input value={draft.notes} placeholder="Optional" onChange={(e) => set({ notes: e.target.value })} />

      <div className="panel__actions">
        <button className="primary" onClick={onSave}>Log sighting</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

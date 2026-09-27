import { useState } from 'react';
import type { Days, GoodTimes, Phase } from '../api.js';
import { PHASE_LABEL, PHASES } from '../map/sun.js';

export const CONDITIONS = ['clear', 'fog', 'overcast', 'storm', 'snow', 'after rain', 'full moon', 'new moon'];
export const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const emptyGoodTimes = (): GoodTimes => ({ phases: [], months: [], days: 'any', conditions: [], eventKeywords: [], avoid: '', notes: '' });

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export default function GoodTimesEditor({ value, onChange }: { value: GoodTimes; onChange: (g: GoodTimes) => void }) {
  const [keyword, setKeyword] = useState('');
  const set = (patch: Partial<GoodTimes>) => onChange({ ...value, ...patch });
  const addKeyword = () => {
    const k = keyword.trim();
    if (k && !value.eventKeywords.includes(k)) set({ eventKeywords: [...value.eventKeywords, k] });
    setKeyword('');
  };

  return (
    <div className="gt">
      <label className="gt__label">Light</label>
      <div className="chiprow">
        {PHASES.map((p) => (
          <button type="button" key={p} className={`chip${value.phases.includes(p) ? ' active' : ''}`} onClick={() => set({ phases: toggle<Phase>(value.phases, p) })}>
            {PHASE_LABEL[p]}
          </button>
        ))}
      </div>

      <label className="gt__label">Months <span className="hint">{value.months.length ? '' : '(any)'}</span></label>
      <div className="months">
        {MONTHS.map((m, i) => (
          <button type="button" key={i} title={MONTH_NAMES[i]} className={value.months.includes(i + 1) ? 'active' : ''}
            onClick={() => set({ months: toggle(value.months, i + 1).sort((a, b) => a - b) })}>{m}</button>
        ))}
      </div>

      <label className="gt__label">Days</label>
      <div className="seg">
        {(['any', 'weekday', 'weekend'] as Days[]).map((d) => (
          <button type="button" key={d} className={value.days === d ? 'active' : ''} onClick={() => set({ days: d })}>{d}</button>
        ))}
      </div>

      <label className="gt__label">Conditions</label>
      <div className="chiprow">
        {CONDITIONS.map((c) => (
          <button type="button" key={c} className={`chip${value.conditions.includes(c) ? ' active' : ''}`} onClick={() => set({ conditions: toggle(value.conditions, c) })}>{c}</button>
        ))}
      </div>

      <label className="gt__label">Event keywords</label>
      <div className="chiprow">
        {value.eventKeywords.map((k) => (
          <button type="button" key={k} className="chip active" title="Remove" onClick={() => set({ eventKeywords: value.eventKeywords.filter((x) => x !== k) })}>{k} ✕</button>
        ))}
      </div>
      <div className="feedrow" style={{ marginTop: 6 }}>
        <input value={keyword} placeholder="e.g. Bathurst 1000" onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }} />
        <button type="button" onClick={addKeyword}>Add</button>
      </div>

      <label className="gt__label">Avoid</label>
      <input value={value.avoid} placeholder="e.g. closed race weekends" onChange={(e) => set({ avoid: e.target.value })} />
      <label className="gt__label">Notes</label>
      <textarea rows={2} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
    </div>
  );
}

/** Read-only chips for a spot's good times. */
export function GoodTimesChips({ value }: { value: GoodTimes }) {
  const chips = [
    ...value.phases.map((p) => PHASE_LABEL[p]),
    ...(value.months.length ? [value.months.map((m) => MONTH_NAMES[m - 1]).join(' ')] : []),
    ...(value.days !== 'any' ? [value.days] : []),
    ...value.conditions,
    ...value.eventKeywords.map((k) => `🎟 ${k}`),
  ];
  if (!chips.length && !value.avoid && !value.notes) return <p className="hint">No good times set.</p>;
  return (
    <>
      <div className="chiprow">{chips.map((c, i) => <span key={i} className="chip">{c}</span>)}</div>
      {value.avoid && <p className="hint">Avoid: {value.avoid}</p>}
      {value.notes && <p className="hint">{value.notes}</p>}
    </>
  );
}

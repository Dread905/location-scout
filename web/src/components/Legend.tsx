import { useMemo, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { CATEGORIES, swatchColor, type Category, type LegendLayer, type Visibility } from '../map/legend.js';

function Swatch({ cat, color }: { cat: Category; color: string }) {
  return <span className={`legend__swatch legend__swatch--${cat.swatch}`} style={{ '--sw': color } as React.CSSProperties} aria-hidden />;
}

/** Collapsible map legend: one row per layer category, with a swatch and a visibility checkbox. */
export function Legend({ map, vis, onToggle }: { map: MlMap | null; vis: Visibility; onToggle: (key: string, on: boolean) => void }) {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 820);
  const layers = useMemo(() => (map?.getStyle().layers ?? []) as LegendLayer[], [map]);
  const groups = ['Base map', 'Overlays'] as const;
  return (
    <div className={`legend${open ? ' legend--open' : ''}`}>
      <button className={`chip${open ? ' active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>Legend</button>
      {open && (
        <div className="legend__panel">
          {groups.map((g) => (
            <div key={g}>
              <h4>{g}</h4>
              {CATEGORIES.filter((c) => c.group === g).map((c) => (
                <label key={c.key} className="legend__row">
                  <Swatch cat={c} color={swatchColor(c, layers)} />
                  <span className="grow">{c.label}</span>
                  <input type="checkbox" checked={!!vis[c.key]} onChange={(e) => onToggle(c.key, e.target.checked)} />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

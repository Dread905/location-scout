import { useMemo, useState } from 'react';
import type { Plane, TrainPosition } from '../api.js';
import { capRows, NEARBY_CAP, planeRows, trainRows, type PlaneRow, type TrainRow } from '../map/nearby.js';

interface Props {
  planes: Plane[] | null; // null = feed off
  trains: TrainPosition[] | null;
  centre: { lat: number; lng: number };
  onHover: (at: [number, number] | null) => void;
  onPlane: (row: PlaneRow) => void;
  onTrain: (row: TrainRow) => void;
  /** Keep the camera on a vehicle; `following` is the id currently followed. */
  onFollow?: (kind: 'plane' | 'train', row: PlaneRow | TrainRow) => void;
  following?: string | null;
}

function Section<T extends { id: string; lat: number; lng: number }>({ title, rows, render, onHover, onPick, onFollow, following }: {
  title: string; rows: T[]; render: (r: T) => React.ReactNode; onHover: Props['onHover']; onPick: (r: T) => void;
  onFollow?: (r: T) => void; following?: string | null;
}) {
  const [all, setAll] = useState(false);
  const shown = capRows(rows, all);
  return (
    <section className="nearby__section">
      <h4>{title} <span className="nearby__count">{rows.length}</span></h4>
      {rows.length === 0 && <p className="nearby__empty">None in range</p>}
      <ul>
        {shown.map((r) => (
          <li key={r.id}>
            <button className="nearby__row" onMouseEnter={() => onHover([r.lng, r.lat])} onMouseLeave={() => onHover(null)}
              onFocus={() => onHover([r.lng, r.lat])} onBlur={() => onHover(null)} onClick={() => onPick(r)}>{render(r)}</button>
            {onFollow && (
              <button className={`nearby__follow${following === r.id ? ' active' : ''}`} onClick={() => onFollow(r)}
                title="Keep the map centred on it" aria-pressed={following === r.id}>{following === r.id ? 'Following' : 'Follow'}</button>
            )}
          </li>
        ))}
      </ul>
      {rows.length > NEARBY_CAP && (
        <button className="linklike nearby__more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>
      )}
    </section>
  );
}

/** Collapsible list of planes and trains near the map centre, nearest first. */
export function NearbyList({ planes, trains, centre, onHover, onPlane, onTrain, onFollow, following }: Props) {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 820);
  const pRows = useMemo(() => (planes ? planeRows(planes, centre) : null), [planes, centre.lat, centre.lng]);
  const tRows = useMemo(() => (trains ? trainRows(trains, centre) : null), [trains, centre.lat, centre.lng]);
  if (!pRows && !tRows) return null;
  const total = (pRows?.length ?? 0) + (tRows?.length ?? 0);
  return (
    <div className={`nearby${open ? ' nearby--open' : ''}`}>
      <button className={`chip${open ? ' active' : ''}`} onClick={() => { setOpen(!open); onHover(null); }} aria-expanded={open}>Nearby · {total}</button>
      {open && (
        <div className="nearby__panel" onMouseLeave={() => onHover(null)}>
          {pRows && (
            <Section title="✈ Planes" rows={pRows} onHover={onHover} onPick={onPlane} following={following}
              onFollow={onFollow && ((r) => onFollow('plane', r))} render={(r) => (
              <>
                <span className="nearby__arrow" style={{ transform: `rotate(${r.track ?? 0}deg)`, opacity: r.track == null ? 0.3 : 1 }} aria-hidden>↑</span>
                <span className="nearby__main"><strong>{r.name}</strong>{r.type && <span className="nearby__sub"> {r.type}</span>}
                  <span className="nearby__sub nearby__line">{r.alt} · {r.speed}</span></span>
                <span className="nearby__dist">{r.dist}</span>
              </>
            )} />
          )}
          {tRows && (
            <Section title="🚆 Trains" rows={tRows} onHover={onHover} onPick={onTrain} following={following}
              onFollow={onFollow && ((r) => onFollow('train', r))} render={(r) => (
              <>
                <span className="nearby__main"><strong>{r.title}</strong>
                  <span className="nearby__line"><span className={`nearby__badge${r.live ? ' nearby__badge--live' : ''}`}>{r.live ? 'live' : 'scheduled'}</span>
                    <span className="nearby__sub"> {r.delay}</span></span></span>
                <span className="nearby__dist">{r.dist}</span>
              </>
            )} />
          )}
        </div>
      )}
    </div>
  );
}

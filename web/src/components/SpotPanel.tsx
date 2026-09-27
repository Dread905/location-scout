import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Place, Spot } from '../api.js';
import { alignments, Alignment, goodNow } from '../map/sun.js';
import { hhmm } from '../time.js';
import DayStrip from './DayStrip.js';
import { GoodTimesChips } from './GoodTimesEditor.js';
import Photos from './Photos.js';

export function formatAlignment(a: Alignment) {
  const day = a.start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${a.body === 'sun' ? '☀ Sun' : '☾ Moon'} ${day} ${hhmm(a.start)}–${hhmm(a.end)} · ${Math.round(a.azimuth)}°`;
}

export default function SpotPanel({ spot, place, time, canEdit, onEdit, onDelete, onMove, onCreateSpotAt }: {
  spot: Spot;
  place: Place | undefined;
  time: Date;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (lat: number, lng: number) => void;
  onCreateSpotAt: (lat: number, lng: number) => Promise<Spot>;
}) {
  const next = useMemo(() => alignments(spot, time, 365, 3), [spot, time]); // cached per day, so cheap to redo
  const good = goodNow(spot, time);

  return (
    <>
      <h2>{spot.name} {good && <span className="badge-good">Good now</span>}</h2>
      <p className="hint">
        {place && <><Link to={`/places/${place.id}`}>{place.name}</Link> · </>}
        {spot.facingDeg != null ? `Facing ${Math.round(spot.facingDeg)}° (${spot.fovDeg ?? 60}° FOV)` : 'No facing set'} · {spot.visibility}
      </p>
      {spot.notes && <p className="panel__notes">{spot.notes}</p>}
      {spot.tags.length > 0 && <div className="chiprow">{spot.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>}

      <h4>Photos</h4>
      <Photos spot={spot} canEdit={canEdit} onMoveSpot={onMove} onCreateSpotAt={onCreateSpotAt} />

      <h4>Good times</h4>
      <GoodTimesChips value={spot.goodTimes} />

      <h4>{time.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
      <DayStrip lat={spot.lat} lng={spot.lng} time={time} />

      <h4>Next alignments</h4>
      {spot.facingDeg == null ? <p className="hint">Set a facing to find sun and moon alignments.</p>
        : next.length === 0 ? <p className="hint">No sun or moon on this bearing within a year.</p>
        : <ul className="plainlist">{next.map((a) => <li key={a.start.getTime() + a.body}>{formatAlignment(a)}</li>)}</ul>}

      <h4>Nearby</h4>
      {/* Phase 3 hook: events (Event Scout), crowd now vs typical, next trains/planes passing this spot. */}
      <p className="hint">Events, crowds and trains arrive in a later phase.</p>

      {canEdit && (
        <div className="panel__actions">
          <button className="primary" onClick={onEdit}>Edit</button>
          <button onClick={onDelete}>Delete</button>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { api, Spot } from '../api.js';

/** Placeholder list of spots. Phase 2 replaces this with the MapLibre map. */
export default function Spots() {
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.spots().then(setSpots).catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div className="page">
      <h1>Spots</h1>
      {error && <p className="status-line error">{error}</p>}
      {!spots && !error && <p className="hint">Loading…</p>}
      {spots && spots.length === 0 && <div className="empty">No spots yet. The map and editor land in phase 2.</div>}
      {spots && spots.length > 0 && (
        <ul className="places__list">
          {spots.map((s) => (
            <li key={s.id}>
              <div className="places__row" style={{ cursor: 'default' }}>
                <span className="places__name">{s.name}</span>
                <span className="places__busiest">{s.lat.toFixed(4)}, {s.lng.toFixed(4)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

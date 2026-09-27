import { useEffect, useState } from 'react';
import { api, CommonsImage, NearbyResult, Spot, TrainPass } from '../api.js';
import { hhmm } from '../time.js';

/** Phase 3 "Nearby": Event Scout events and crowd, next trains passing, and Commons inspiration. */
export default function Nearby({ spot }: { spot: Spot }) {
  const [nearby, setNearby] = useState<NearbyResult | null>(null);
  const [trains, setTrains] = useState<{ configured: boolean; passes: TrainPass[] } | null>(null);
  const [commons, setCommons] = useState<CommonsImage[] | null>(null);

  useEffect(() => {
    setNearby(null); setTrains(null); setCommons(null);
    api.spotNearby(spot.id).then(setNearby).catch(() => setNearby({ events: [], crowd: null, status: 'not_configured' }));
    api.spotTrains(spot.id).then(setTrains).catch(() => setTrains({ configured: false, passes: [] }));
    api.spotCommons(spot.id).then(setCommons).catch(() => setCommons([]));
  }, [spot.id]);

  return (
    <>
      {nearby?.status === 'not_configured' && <p className="hint">Event Scout isn't set up — add its URL in Settings for nearby events and crowd levels.</p>}
      {nearby?.status === 'ok' && (
        <>
          {nearby.crowd && (
            <p className="hint">
              👥 {nearby.crowd.venue}: {nearby.crowd.live ?? '—'} now vs {nearby.crowd.typical ?? '—'} typical
              {nearby.crowd.bestWindow ? ` · best window ${nearby.crowd.bestWindow}` : ''}
            </p>
          )}
          {nearby.events.length === 0 ? (
            <p className="hint">No events in the next 7 days.</p>
          ) : (
            <ul className="plainlist">
              {nearby.events.slice(0, 6).map((e, i) => (
                <li key={i}>
                  {e.goodDuring && <span className="badge-good">Match</span>} {e.title}
                  {' — '}{new Date(e.startTime).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h4>Next trains passing</h4>
      {trains && !trains.configured && <p className="hint">Trains aren't set up — add a TfNSW API key in Settings. Freight and Indian Pacific trains aren't in that feed either way.</p>}
      {trains?.configured && trains.passes.length === 0 && <p className="hint">None in the next few hours.</p>}
      {trains?.configured && trains.passes.length > 0 && (
        <ul className="plainlist">{trains.passes.slice(0, 5).map((p) => <li key={p.tripId + p.at}>{p.route || p.headsign || 'Train'} · {hhmm(new Date(p.at))}</li>)}</ul>
      )}

      {commons && commons.length > 0 && (
        <>
          <h4>Inspiration from Commons</h4>
          <div className="photos__grid">
            {commons.map((c) => (
              <a key={c.pageUrl} href={c.pageUrl} target="_blank" rel="noreferrer" title={c.title}>
                {c.thumbUrl && <img src={c.thumbUrl} alt={c.title} />}
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

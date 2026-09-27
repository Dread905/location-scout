import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Settings, Spot } from '../api.js';
import { haversineKm } from '../map/geo.js';
import { Alignment, alignments, nextGoodWindow, PHASE_LABEL, Phase } from '../map/sun.js';
import { hhmm } from '../time.js';
import { MAP_CENTRE_KEY } from './MapPage.js';

const DAYS = 7;
const ALIGN_BONUS_H = 12;
const CROWD_LOOKUP_CAP = 50; // ponytail: one Event Scout lookup per spot; fine at personal-app scale, cap avoids hammering it on a big radius

interface Row { spot: Spot; km: number; good: { start: Date; end: Date; phase: Phase } | null; align: Alignment | null; score: number }

/** A busier-than-typical venue near the spot pushes it later in the ranking (score is "hours until", lower is better). */
function crowdPenaltyHours(crowdScore: number | undefined): number {
  return crowdScore == null ? 0 : crowdScore * 12;
}

function readCentre(): { lat: number; lng: number } | null {
  try { return JSON.parse(localStorage.getItem(MAP_CENTRE_KEY) ?? 'null'); } catch { return null; }
}

const when = (d: Date) => `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(d)}`;

/** Spots within X km, ranked by their next good window over the coming week, aligned ones first. */
export default function Trip() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [from, setFrom] = useState<'home' | 'map'>('home');
  const [radiusKm, setRadiusKm] = useState(50);
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [crowdScores, setCrowdScores] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  useEffect(() => { api.settings().then(setSettings).catch((err) => setError((err as Error).message)); }, []);
  const origin = from === 'map' ? readCentre() ?? settings?.home : settings?.home;

  useEffect(() => {
    if (!origin) return;
    setSpots(null);
    setCrowdScores({});
    api.spots({ near: `${origin.lat},${origin.lng}`, radiusKm }).then(setSpots).catch((err) => setError((err as Error).message));
  }, [origin?.lat, origin?.lng, radiusKm]);

  useEffect(() => {
    if (!spots) return;
    for (const spot of spots.slice(0, CROWD_LOOKUP_CAP)) {
      api.spotNearby(spot.id).then((r) => {
        if (r.crowd?.score != null) setCrowdScores((prev) => ({ ...prev, [spot.id]: r.crowd!.score! }));
      }).catch(() => {});
    }
  }, [spots]);

  const rows = useMemo(() => {
    if (!spots || !origin) return [];
    const now = new Date();
    const out: Row[] = [];
    for (const spot of spots) {
      const good = nextGoodWindow(spot, now, DAYS);
      const align = alignments(spot, now, DAYS, 1)[0] ?? null;
      const first = [good?.start, align?.start].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0];
      if (!first) continue;
      const hours = (first.getTime() - now.getTime()) / 3_600_000;
      out.push({ spot, km: haversineKm(origin.lat, origin.lng, spot.lat, spot.lng), good, align, score: hours - (align ? ALIGN_BONUS_H : 0) + crowdPenaltyHours(crowdScores[spot.id]) });
    }
    return out.sort((a, b) => a.score - b.score);
  }, [spots, crowdScores]);

  return (
    <div className="page">
      <h1>Plan a trip</h1>
      <div className="filterbar">
        <div className="seg">
          <button className={from === 'home' ? 'active' : ''} onClick={() => setFrom('home')}>From home{settings ? ` (${settings.home.name})` : ''}</button>
          <button className={from === 'map' ? 'active' : ''} onClick={() => setFrom('map')}>From map centre</button>
        </div>
        <label className="toggle toggle--inline">
          Within {radiusKm} km
          <input type="range" min={5} max={300} step={5} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
        </label>
      </div>
      <p className="hint">The next {DAYS} days. A spot counts when its good times match, or when the sun or moon lines up with its facing; alignments rank higher.</p>
      {error && <p className="status-line error">{error}</p>}
      {!spots && !error && <p className="hint">Loading…</p>}
      {spots && rows.length === 0 && <div className="empty">No spots with good times or a facing within {radiusKm} km.</div>}
      {rows.length > 0 && (
        <table className="triptable">
          <thead><tr><th>Spot</th><th>Distance</th><th>Next good light</th><th>Alignment</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.spot.id}>
                <td><Link to={`/?spot=${r.spot.id}`}>{r.spot.name}</Link></td>
                <td>{r.km.toFixed(1)} km</td>
                <td>{r.good ? `${PHASE_LABEL[r.good.phase]} · ${when(r.good.start)}–${hhmm(r.good.end)}` : '—'}</td>
                <td>{r.align ? `${r.align.body === 'sun' ? '☀' : '☾'} ${when(r.align.start)} · ${Math.round(r.align.azimuth)}°` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

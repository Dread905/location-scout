import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, Plane, Settings, Spot } from '../api.js';
import { haversineKm } from '../map/geo.js';
import { Alignment, alignments, nextGoodWindow, PHASE_LABEL, Phase } from '../map/sun.js';
import { hhmm, ymd } from '../time.js';
import DayStrip from '../components/DayStrip.js';
import { bestWindows, buildingShadeAt, lightTimeline, WINDOW_LABEL, type ShadeTest, type WindowKind } from '../map/shootPlan.js';
import { terrainShadeForPoint } from '../map/demPoint.js';
import type { Footprint } from '../map/shadows.js';
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

const OVERHEAD_KM = 5;
const LIGHT_COLOR = { sun: '#f5c542', shade: '#4a5068', night: '#05070f' } as const;
const WINDOW_COLOR: Record<WindowKind, string> = { 'golden-sun': '#f5a623', 'even-shade': '#8fa3c8' };

/** One spot on one day: planes overhead now, sun/shade from terrain and buildings, best windows. */
function ShootDay({ spot, date }: { spot: Spot; date: Date }) {
  const [terrain, setTerrain] = useState<ShadeTest | null | 'loading'>('loading');
  const [buildings, setBuildings] = useState<ShadeTest | null | 'loading'>('loading');
  const [planes, setPlanes] = useState<{ p: Plane; km: number }[] | null | 'error'>(null);

  useEffect(() => {
    let live = true;
    setTerrain('loading'); setBuildings('loading');
    terrainShadeForPoint(spot.lat, spot.lng).then((t) => live && setTerrain(() => t)).catch(() => live && setTerrain(null));
    api.buildings(spot.lat, spot.lng).then((fc) => live && setBuildings(() => buildingShadeAt(fc.features as Footprint[], spot.lng, spot.lat)))
      .catch(() => live && setBuildings(null));
    return () => { live = false; };
  }, [spot.id]);

  const loadPlanes = () => {
    setPlanes(null);
    api.planes(spot.lat, spot.lng, 5).then((ps) => setPlanes(ps.map((p) => ({ p, km: haversineKm(spot.lat, spot.lng, p.lat, p.lon) }))
      .filter((x) => x.km <= OVERHEAD_KM).sort((a, b) => a.km - b.km))).catch(() => setPlanes('error'));
  };
  useEffect(loadPlanes, [spot.id]);

  const ready = terrain !== 'loading' && buildings !== 'loading';
  const steps = useMemo(() => ready ? lightTimeline(date, spot.lat, spot.lng, { terrain: terrain as ShadeTest | null, buildings: buildings as ShadeTest | null }) : [],
    [ready, terrain, buildings, date.getTime(), spot.id]);
  const windows = useMemo(() => bestWindows(steps), [steps]);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const pct = (t: number) => `${((t - dayStart) / 86_400_000) * 100}%`;
  const future = date.getTime() > Date.now() + 30 * 60_000;

  return (
    <section className="shootday">
      <h2>{spot.name} · {date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</h2>
      <h3>Light</h3>
      <DayStrip lat={spot.lat} lng={spot.lng} time={date} />
      {!ready ? <p className="hint">Working out sun and shade…</p> : (
        <>
          <div className="daystrip__row" title="Sun or shade at the spot" aria-label="Sun and shade at the spot">
            {steps.map((s) => (
              <div key={s.t.getTime()} className="daystrip__band" style={{ left: pct(s.t.getTime()), width: pct(dayStart + 10 * 60_000), background: LIGHT_COLOR[s.light] }}
                title={`${hhmm(s.t)} ${s.light}${s.terrain ? ' (terrain)' : s.buildings ? ' (buildings)' : ''}`} />
            ))}
          </div>
          <div className="daystrip__row daystrip__row--moon" aria-label="Best windows">
            {windows.map((w) => (
              <div key={w.start.getTime()} className="daystrip__band" style={{ left: pct(w.start.getTime()), width: pct(dayStart + w.end.getTime() - w.start.getTime()), background: WINDOW_COLOR[w.kind] }} />
            ))}
          </div>
          <p className="hint">
            <span style={{ color: LIGHT_COLOR.sun }}>■</span> sun <span style={{ color: LIGHT_COLOR.shade }}>■</span> shade (terrain{terrain ? '' : ' unavailable'}, buildings{buildings ? '' : ' unavailable'}) ·
            best: <span style={{ color: WINDOW_COLOR['golden-sun'] }}>■</span> {WINDOW_LABEL['golden-sun'].toLowerCase()} <span style={{ color: WINDOW_COLOR['even-shade'] }}>■</span> {WINDOW_LABEL['even-shade'].toLowerCase()}
          </p>
          {windows.length ? (
            <ul className="plainlist shootday__windows">
              {windows.map((w) => <li key={w.start.getTime()}><strong>{WINDOW_LABEL[w.kind]}</strong> · {hhmm(w.start)}–{hhmm(w.end)}</li>)}
            </ul>
          ) : <p className="hint">No golden-hour sun or daytime shade at the spot on this day.</p>}
        </>
      )}
      <h3>Planes overhead</h3>
      {future && <p className="hint">Live traffic right now, not at {hhmm(date)}: there's no data source for future or typical overhead traffic.</p>}
      {planes === null ? <p className="hint">Loading…</p> : planes === 'error' ? <p className="hint">Plane feed unavailable.</p> : planes.length === 0
        ? <p className="hint">No planes within {OVERHEAD_KM} km right now.</p>
        : <ul className="plainlist">{planes.map(({ p, km }) => <li key={p.hex}>✈ {p.flight?.trim() || p.hex} · {km.toFixed(1)} km · {p.alt_baro != null ? `${p.alt_baro} ft` : 'alt ?'}</li>)}</ul>}
      <button onClick={loadPlanes}>Refresh planes</button>
    </section>
  );
}

/** Spots within X km, ranked by their next good window over the coming week, aligned ones first; plan one for a day. */
export default function PlanShoot() {
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(() => { const d = new Date(); d.setSeconds(0, 0); return d; });
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

  const plan = rows.find((r) => r.spot.id === params.get('spot'))?.spot ?? rows[0]?.spot ?? null;

  return (
    <div className="page">
      <h1>Plan shoot</h1>
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
      {plan && (
        <>
          <div className="filterbar">
            <label>Date <input type="date" value={ymd(date)} onChange={(e) => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) setDate(new Date(y, m - 1, d, date.getHours(), date.getMinutes())); }} /></label>
            <label>Time <input type="time" value={hhmm(date)} onChange={(e) => { const [h, mi] = e.target.value.split(':').map(Number); if (h != null && !Number.isNaN(h)) setDate(new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, mi)); }} /></label>
          </div>
          <ShootDay spot={plan} date={date} />
        </>
      )}
      {rows.length > 0 && (
        <table className="triptable">
          <thead><tr><th></th><th>Spot</th><th>Distance</th><th>Next good light</th><th>Alignment</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.spot.id} className={plan?.id === r.spot.id ? 'active' : ''}>
                <td><button onClick={() => setParams({ spot: r.spot.id })}>Plan</button></td>
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

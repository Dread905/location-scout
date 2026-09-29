import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, Plane, Settings, Spot, TrainPass } from '../api.js';
import { haversineKm } from '../map/geo.js';
import { Alignment, alignments, moonPhase, nextGoodWindow, PHASE_LABEL, Phase, sunriseSunset } from '../map/sun.js';
import { hhmm, hhmm24, ymd } from '../time.js';
import DayStrip from '../components/DayStrip.js';
import { bestWindows, buildingShadeAt, lightTimeline, WINDOW_LABEL, type ShadeTest, type Step, type WindowKind } from '../map/shootPlan.js';
import { terrainShadeForPoint } from '../map/demPoint.js';
import type { Footprint } from '../map/shadows.js';
import { CRITERIA, DEFAULT_CRITERIA, parseCriteria, railDistanceKm, recommend, weatherAt, type Criterion, type Recommendation, type WeatherHour, type WeatherResponse } from '../map/recommend.js';
import { fetchWeather } from './planWeather.js';
import { MAP_CENTRE_KEY } from './MapPage.js';
import SunBearingPlanner from '../components/SunBearingPlanner.js';

const ALIGN_BONUS_H = 12;
const CROWD_LOOKUP_CAP = 50; // ponytail: one Event Scout lookup per spot; fine at personal-app scale, cap avoids hammering it on a big radius
const CRITERIA_KEY = 'plan:criteria';
const RAIL_NEAR_KM = 1;
const OVERHEAD_KM = 5;
const TRAIN_WINDOW_MIN = 10;
const LIGHT_COLOR = { sun: '#f5c542', shade: '#4a5068', night: '#05070f' } as const;
const WINDOW_COLOR: Record<WindowKind, string> = { 'golden-sun': '#f5a623', 'even-shade': '#8fa3c8' };
type Tab = 'rec' | 'day' | 'weather' | 'trains' | 'spots';
const TABS: { key: Tab; label: string }[] = [
  { key: 'rec', label: 'Recommended' }, { key: 'day', label: 'Day timeline' }, { key: 'weather', label: 'Weather' },
  { key: 'trains', label: 'Trains & planes' }, { key: 'spots', label: 'Spots' },
];

interface Row { spot: Spot; km: number; good: { start: Date; end: Date; phase: Phase } | null; align: Alignment | null; score: number }

/** A busier-than-typical venue near the spot pushes it later in the ranking (score is "hours until", lower is better). */
function crowdPenaltyHours(crowdScore: number | undefined): number {
  return crowdScore == null ? 0 : crowdScore * 12;
}
function readCentre(): { lat: number; lng: number } | null {
  try { return JSON.parse(localStorage.getItem(MAP_CENTRE_KEY) ?? 'null'); } catch { return null; }
}
function storedCriteria(): Criterion[] | null {
  try { return parseCriteria(localStorage.getItem(CRITERIA_KEY)); } catch { return null; }
}
const dayLabel = (d: Date) => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const when = (d: Date) => `${dayLabel(d)} ${hhmm(d)}`;
const parseYmd = (s: string | null) => { const [y, m, d] = (s ?? '').split('-').map(Number); return y && m && d ? new Date(y, m - 1, d) : null; };
const localIso = (d: Date) => `${ymd(d)}T${hhmm24(d)}`;
const parseLocal = (s: string | null) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const trainLabel = (p: TrainPass) => p.route || p.headsign || 'Train';
/** OSM tile containing the point at zoom z, for the print thumbnail. */
function tileUrl(lat: number, lng: number, z = 15) {
  const n = 2 ** z, x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180, y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
const CONF_COLOR = { high: 'var(--green)', medium: 'var(--accent)', low: 'var(--red)' } as const;

/** Per-hour cloud / rain / wind strip across one local day. */
function WeatherStrip({ hourly, day }: { hourly: WeatherHour[]; day: Date }) {
  const hours = Array.from({ length: 24 }, (_, h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h));
  const ws = hours.map((t) => weatherAt(hourly, t));
  if (!ws.some(Boolean)) return <p className="hint">No forecast for this day.</p>;
  return (
    <div className="wxstrip" aria-label="Hourly cloud, rain and wind">
      {ws.map((w, h) => (
        <div key={h} className="wxstrip__cell" title={w ? `${h % 12 || 12}${h < 12 ? 'am' : 'pm'} · ${Math.round(w.cloudPct)}% cloud · ${Math.round(w.precipProbPct)}% rain · ${Math.round(w.windKmh)} km/h` : 'no data'}>
          <div className="wxstrip__cloud" style={{ opacity: w ? 0.1 + (w.cloudPct / 100) * 0.9 : 0 }} />
          <div className="wxstrip__rain"><div style={{ height: `${w ? w.precipProbPct : 0}%` }} /></div>
          <div className="wxstrip__wind">{w ? Math.round(w.windKmh) : ''}</div>
          {h % 3 === 0 && <div className="wxstrip__h">{h}</div>}
        </div>
      ))}
    </div>
  );
}

function LightStrip({ steps, day }: { steps: Step[]; day: Date }) {
  const windows = bestWindows(steps);
  const dayStart = startOfDay(day).getTime();
  const pct = (t: number) => `${((t - dayStart) / 86_400_000) * 100}%`;
  return (
    <>
      <div className="daystrip__row" aria-label="Sun and shade at the spot">
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
      {windows.length ? (
        <ul className="plainlist shootday__windows">
          {windows.map((w) => <li key={w.start.getTime()}><strong>{WINDOW_LABEL[w.kind]}</strong> · {hhmm(w.start)}–{hhmm(w.end)}</li>)}
        </ul>
      ) : <p className="hint">No golden-hour sun or daytime shade at the spot on this day.</p>}
    </>
  );
}

export default function PlanShoot() {
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v == null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });

  const today = startOfDay(new Date());
  const fromDay = parseYmd(params.get('from')) ?? today;
  const days = Math.min(14, Math.max(1, Number(params.get('days')) || 7));
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'rec') as Tab;
  const criteria = parseCriteria(params.get('crit')) ?? storedCriteria() ?? DEFAULT_CRITERIA;
  const selected = parseLocal(params.get('at'));

  const [settings, setSettings] = useState<Settings | null>(null);
  const [from, setFrom] = useState<'home' | 'map'>('home');
  const [radiusKm, setRadiusKm] = useState(50);
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [crowdScores, setCrowdScores] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [spotQuery, setSpotQuery] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => { api.settings().then(setSettings).catch((err) => setError((err as Error).message)); }, []);
  const origin = from === 'map' ? readCentre() ?? settings?.home : settings?.home;

  useEffect(() => {
    if (!origin) return;
    setSpots(null); setCrowdScores({});
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
    return spots.map((spot): Row => {
      const good = nextGoodWindow(spot, now, days);
      const align = alignments(spot, now, days, 1)[0] ?? null;
      const first = [good?.start, align?.start].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0];
      const hours = first ? (first.getTime() - now.getTime()) / 3_600_000 : 1e6;
      return { spot, km: haversineKm(origin.lat, origin.lng, spot.lat, spot.lng), good, align, score: hours - (align ? ALIGN_BONUS_H : 0) + crowdPenaltyHours(crowdScores[spot.id]) };
    }).sort((a, b) => a.score - b.score);
  }, [spots, crowdScores, days]);

  const [linkedSpot, setLinkedSpot] = useState<Spot | null>(null);
  const spotId = params.get('spot');
  useEffect(() => {
    if (spotId && spots && !spots.some((s) => s.id === spotId)) api.spot(spotId).then(setLinkedSpot).catch(() => {});
  }, [spotId, spots]);
  const plan = spots?.find((s) => s.id === spotId) ?? (linkedSpot?.id === spotId ? linkedSpot : null) ?? rows[0]?.spot ?? null;

  // --- per-spot data -------------------------------------------------------------------
  const [terrain, setTerrain] = useState<ShadeTest | null | 'loading'>('loading');
  const [buildings, setBuildings] = useState<ShadeTest | null | 'loading'>('loading');
  const [buildingsErr, setBuildingsErr] = useState('');
  const [weather, setWeather] = useState<WeatherResponse | null | 'loading'>('loading');
  const [weatherErr, setWeatherErr] = useState('');
  const [passes, setPasses] = useState<{ configured: boolean; passes: TrainPass[] } | null>(null);
  const [rail, setRail] = useState<GeoJSON.FeatureCollection | null>(null);
  const [planes, setPlanes] = useState<{ p: Plane; km: number }[] | null | 'error'>(null);

  useEffect(() => { api.rail().then(setRail).catch(() => setRail(null)); }, []);
  useEffect(() => {
    if (!plan) return;
    let live = true;
    setTerrain('loading'); setBuildings('loading'); setBuildingsErr('');
    terrainShadeForPoint(plan.lat, plan.lng).then((t) => live && setTerrain(() => t)).catch(() => live && setTerrain(null));
    api.buildings(plan.lat, plan.lng).then((fc) => live && setBuildings(() => buildingShadeAt(fc.features as Footprint[], plan.lng, plan.lat)))
      .catch((err) => { if (live) { setBuildings(null); setBuildingsErr((err as Error).message); } });
    return () => { live = false; };
  }, [plan?.id]);
  useEffect(() => {
    if (!plan) return;
    let live = true;
    setWeather('loading'); setWeatherErr('');
    fetchWeather(plan.lat, plan.lng, 16).then((w) => live && setWeather(w)).catch((err) => { if (live) { setWeather(null); setWeatherErr((err as Error).message); } });
    return () => { live = false; };
  }, [plan?.id]);
  const rangeEnd = addDays(fromDay, days);
  const trainHours = Math.min(14 * 24, Math.max(1, Math.ceil((rangeEnd.getTime() - Date.now()) / 3_600_000)));
  useEffect(() => {
    if (!plan) return;
    setPasses(null);
    api.spotTrains(plan.id, trainHours).then(setPasses).catch(() => setPasses({ configured: false, passes: [] }));
  }, [plan?.id, trainHours]);
  const loadPlanes = () => {
    if (!plan) return;
    setPlanes(null);
    api.planes(plan.lat, plan.lng, 5).then((ps) => setPlanes(ps.map((p) => ({ p, km: haversineKm(plan.lat, plan.lng, p.lat, p.lon) }))
      .filter((x) => x.km <= OVERHEAD_KM).sort((a, b) => a.km - b.km))).catch(() => setPlanes('error'));
  };
  useEffect(loadPlanes, [plan?.id]);

  const shadeReady = terrain !== 'loading' && buildings !== 'loading';
  const steps = useMemo(() => {
    if (!plan || !shadeReady) return [] as Step[];
    const shade = { terrain: terrain as ShadeTest | null, buildings: buildings as ShadeTest | null };
    return Array.from({ length: days }, (_, i) => lightTimeline(addDays(fromDay, i), plan.lat, plan.lng, shade)).flat();
  }, [plan?.id, shadeReady, terrain, buildings, fromDay.getTime(), days]);

  const trainPasses = useMemo(() => (passes?.passes ?? []).map((p) => ({ at: new Date(p.at), label: trainLabel(p), raw: p }))
    .filter((p) => p.at >= fromDay && p.at < rangeEnd), [passes, fromDay.getTime(), rangeEnd.getTime()]);
  const railKm = plan ? railDistanceKm(rail, plan.lat, plan.lng) : Infinity;
  const trainAvailable = (passes?.configured ?? false) && (railKm <= RAIL_NEAR_KM || trainPasses.length > 0);
  const aligns = useMemo(() => plan ? alignments(plan, fromDay, days, 60).map((a) => ({ start: a.start, end: a.end, label: `${a.body === 'sun' ? 'Sun' : 'Moon'} lines up (${Math.round(a.azimuth)}°)` })) : [],
    [plan?.id, fromDay.getTime(), days]);
  const hourly = weather && weather !== 'loading' ? weather.hourly : null;
  const planeCount = Array.isArray(planes) ? planes.length : null;

  const effective = criteria.filter((c) => (c !== 'train' || trainAvailable) && (c !== 'align' || plan?.facingDeg != null));
  const recs: Recommendation[] = useMemo(() => shadeReady && steps.length
    ? recommend({ slots: steps, criteria: effective, weather: hourly, passes: trainPasses, alignments: aligns, livePlanes: planeCount, trainWindowMin: TRAIN_WINDOW_MIN, fmt: hhmm, n: 5 })
    : [], [steps, effective.join(), hourly, trainPasses, aligns, planeCount]);

  const focus = selected ?? recs[0]?.t ?? new Date(Math.max(fromDay.getTime(), Date.now()));
  const focusDay = startOfDay(focus);
  const daySteps = steps.filter((s) => startOfDay(s.t).getTime() === focusDay.getTime());
  const focusRec = recs.find((r) => focus >= r.t && focus < r.end) ?? (selected ? null : recs[0]) ?? null;
  const focusWx = hourly ? weatherAt(hourly, focus) : null;

  const toggleCrit = (c: Criterion) => {
    const next = criteria.includes(c) ? criteria.filter((x) => x !== c) : [...criteria, c];
    try { localStorage.setItem(CRITERIA_KEY, next.join(',')); } catch { /* private mode */ }
    set({ crit: next.join(',') });
  };
  const shareUrl = () => {
    const p = new URLSearchParams(params);
    if (plan) p.set('spot', plan.id);
    p.set('from', ymd(fromDay)); p.set('days', String(days)); p.set('crit', criteria.join(','));
    p.set('at', localIso(focus));
    return `${location.origin}${location.pathname}?${p}`;
  };
  const copyLink = async () => {
    const url = shareUrl();
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); } catch { window.prompt('Copy this link', url); }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  const pick = (d: Date) => set({ at: localIso(d) });

  const filteredRows = rows.filter((r) => r.spot.name.toLowerCase().includes(spotQuery.toLowerCase()));
  const rs = plan ? sunriseSunset(focus, plan.lat, plan.lng) : null;
  const mp = moonPhase(focus);
  const dayList = Array.from({ length: days }, (_, i) => addDays(fromDay, i));
  const dayPasses = trainPasses.filter((p) => startOfDay(p.at).getTime() === focusDay.getTime());

  return (
    <div className="page plan">
      <div className="plan__head no-print">
        <h1>Plan shoot</h1>
        <div className="plan__actions">
          <button onClick={copyLink} disabled={!plan}>{copied ? 'Link copied' : 'Copy link'}</button>
          <button onClick={() => window.print()} disabled={!plan}>Print</button>
        </div>
      </div>

      <div className="plan__controls no-print">
        <label className="plan__field plan__field--spot">Spot
          <select value={plan?.id ?? ''} onChange={(e) => set({ spot: e.target.value, at: null })} aria-label="Spot">
            {!plan && <option value="">{spots ? 'No spots' : 'Loading…'}</option>}
            {plan && !rows.some((r) => r.spot.id === plan.id) && <option value={plan.id}>{plan.name}</option>}
            {rows.map((r) => <option key={r.spot.id} value={r.spot.id}>{r.spot.name} · {r.km.toFixed(0)} km</option>)}
          </select>
        </label>
        <label className="plan__field">From
          <input type="date" value={ymd(fromDay)} onChange={(e) => set({ from: e.target.value || null, at: null })} />
        </label>
        <label className="plan__field">Days
          <select value={days} onChange={(e) => set({ days: e.target.value, at: null })}>
            {[1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="plan__criteria no-print">
        <legend>What are you after?</legend>
        <div className="chiprow">
          {CRITERIA.map((c) => {
            const disabled = (c.key === 'train' && !trainAvailable) || (c.key === 'align' && plan?.facingDeg == null);
            const why = c.key === 'train' && disabled ? (passes && !passes.configured ? 'Train timetables not configured (Settings)' : `No rail line within ${RAIL_NEAR_KM} km`)
              : c.key === 'align' && disabled ? 'Set a facing on this spot to use alignments' : c.hint;
            return (
              <label key={c.key} className={`chip chip--check${criteria.includes(c.key) && !disabled ? ' active' : ''}${disabled ? ' is-disabled' : ''}`} title={why}>
                <input type="checkbox" checked={criteria.includes(c.key)} disabled={disabled} onChange={() => toggleCrit(c.key)} />
                {c.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      {error && <p className="status-line error">{error}</p>}
      {!spots && !error && <p className="hint">Loading…</p>}

      {plan && (
        <div className="no-print">
          <SunBearingPlanner
            lat={plan.lat}
            lng={plan.lng}
            defaultBearingDeg={plan.facingDeg}
            label="Exact bearing planner"
            onApplyTime={pick}
          />
        </div>
      )}

      <nav className="tabs no-print" role="tablist">
        {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => set({ tab: t.key })}>{t.label}</button>)}
      </nav>

      <div className="no-print">
        {!plan && tab !== 'spots' && spots && <div className="empty">No spots within {radiusKm} km. Try the Spots tab to widen the radius.</div>}

        {plan && tab === 'rec' && (
          <section>
            {!shadeReady ? <p className="hint">Working out sun and shade…</p> : recs.length === 0
              ? <div className="empty">Nothing in these {days} days matches enough of what you picked. Try fewer criteria or more days.</div>
              : (
                <ol className="recs">
                  {recs.map((r, i) => (
                    <li key={r.t.getTime()} className={`rec${focusRec === r ? ' active' : ''}`}>
                      <button className="rec__main" onClick={() => pick(r.t)}>
                        <span className="rec__rank">{i + 1}</span>
                        <span className="rec__when"><strong>{dayLabel(r.t)}</strong> {hhmm(r.t)}–{hhmm(r.end)}</span>
                        <span className="rec__score" title="Share of criteria met">{Math.round(r.score * 100)}%</span>
                      </button>
                      <p className="rec__why">{r.reasons.join(' · ') || 'Partial match'}</p>
                      {r.misses.length > 0 && <p className="hint rec__miss">Missing: {r.misses.join(', ')}</p>}
                      <p className="hint"><span style={{ color: CONF_COLOR[r.confidence] }}>●</span> {r.confidence} confidence · {r.confidenceNote}</p>
                    </li>
                  ))}
                </ol>
              )}
            {weather === null && <p className="hint">Weather unavailable{weatherErr ? ` (${weatherErr})` : ''}: weather criteria score neutral or zero.</p>}
            {criteria.includes('planes') && <p className="hint">Planes overhead only counts for right now: there's no forecast of future air traffic.</p>}
          </section>
        )}

        {plan && tab === 'day' && (
          <section className="shootday">
            <div className="chiprow plan__days">
              {dayList.map((d) => (
                <button key={d.getTime()} className={`chip${d.getTime() === focusDay.getTime() ? ' active' : ''}`}
                  onClick={() => pick(new Date(d.getFullYear(), d.getMonth(), d.getDate(), focus.getHours(), focus.getMinutes()))}>{dayLabel(d)}</button>
              ))}
            </div>
            <label className="plan__field">Time <input type="time" value={hhmm24(focus)} onChange={(e) => { const [h, mi] = e.target.value.split(':').map(Number); if (!Number.isNaN(h)) pick(new Date(focus.getFullYear(), focus.getMonth(), focus.getDate(), h, mi)); }} /></label>
            <h3>Light</h3>
            <DayStrip lat={plan.lat} lng={plan.lng} time={focus} />
            {!shadeReady ? <p className="hint">Working out sun and shade…</p> : <LightStrip steps={daySteps} day={focusDay} />}
            <p className="hint">
              <span style={{ color: LIGHT_COLOR.sun }}>■</span> sun <span style={{ color: LIGHT_COLOR.shade }}>■</span> shade (terrain{terrain ? '' : ' unavailable'}, buildings{buildings === 'loading' ? '…' : buildings ? '' : ' unavailable'}) ·
              best: <span style={{ color: WINDOW_COLOR['golden-sun'] }}>■</span> golden on spot <span style={{ color: WINDOW_COLOR['even-shade'] }}>■</span> open shade
            </p>
            {buildings === null && <p className="hint">Building footprints couldn't be loaded{buildingsErr ? `: ${buildingsErr}` : ''}. Shade is from terrain only.</p>}
            <h3>Weather</h3>
            {hourly ? <><WeatherStrip hourly={hourly} day={focusDay} /><p className="hint">Shading = cloud cover · blue bar = rain chance · number = wind km/h</p></>
              : <p className="hint">{weather === 'loading' ? 'Loading forecast…' : 'Weather unavailable.'}</p>}
          </section>
        )}

        {plan && tab === 'weather' && (
          <section>
            {weather === 'loading' ? <p className="hint">Loading forecast…</p> : !hourly ? <p className="hint">Weather unavailable{weatherErr ? ` (${weatherErr})` : ''}.</p> : (
              <>
                {dayList.map((d) => (
                  <div key={d.getTime()} className="plan__wxday">
                    <button className="linklike" onClick={() => set({ tab: 'day', at: localIso(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)) })}>{dayLabel(d)}</button>
                    <WeatherStrip hourly={hourly} day={d} />
                  </div>
                ))}
                <p className="hint">Forecast fetched {new Date((weather as WeatherResponse).fetchedAt).toLocaleString()}. Accuracy drops beyond 2–3 days.</p>
              </>
            )}
          </section>
        )}

        {plan && tab === 'trains' && (
          <section>
            <h3>Trains</h3>
            {!passes ? <p className="hint">Loading timetable…</p> : !passes.configured ? <p className="hint">Train timetables aren't configured (Settings → TfNSW key).</p>
              : trainPasses.length === 0 ? <p className="hint">No timetabled trains pass within 2 km in this range{Number.isFinite(railKm) ? ` (nearest rail ${railKm.toFixed(1)} km)` : ''}.</p>
              : (
                <table className="triptable">
                  <thead><tr><th>When</th><th>Route</th><th>To</th></tr></thead>
                  <tbody>{trainPasses.slice(0, 80).map((p) => (
                    <tr key={`${p.raw.tripId}-${p.raw.at}`}><td><button className="linklike" onClick={() => pick(p.at)}>{when(p.at)}</button></td><td>{p.raw.route}</td><td>{p.raw.headsign}</td></tr>
                  ))}</tbody>
                </table>
              )}
            <h3>Planes overhead now</h3>
            <p className="hint">Live traffic only: there's no data source for future or typical overhead traffic.</p>
            {planes === null ? <p className="hint">Loading…</p> : planes === 'error' ? <p className="hint">Plane feed unavailable.</p> : planes.length === 0
              ? <p className="hint">No planes within {OVERHEAD_KM} km right now.</p>
              : <ul className="plainlist">{planes.map(({ p, km }) => <li key={p.hex}>✈ {p.flight?.trim() || p.hex} · {km.toFixed(1)} km · {p.alt_baro != null ? `${p.alt_baro} ft` : 'alt ?'}</li>)}</ul>}
            <button onClick={loadPlanes}>Refresh planes</button>
          </section>
        )}

        {tab === 'spots' && (
          <section>
            <div className="filterbar">
              <div className="seg">
                <button className={from === 'home' ? 'active' : ''} onClick={() => setFrom('home')}>From home{settings ? ` (${settings.home.name})` : ''}</button>
                <button className={from === 'map' ? 'active' : ''} onClick={() => setFrom('map')}>From map centre</button>
              </div>
              <label className="toggle toggle--inline">Within {radiusKm} km
                <input type="range" min={5} max={300} step={5} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
              </label>
              <input type="search" placeholder="Filter spots" value={spotQuery} onChange={(e) => setSpotQuery(e.target.value)} aria-label="Filter spots" />
            </div>
            <p className="hint">Ranked by the next good light or sun/moon alignment over the next {days} days; alignments rank higher, crowded venues lower.</p>
            {filteredRows.length === 0 ? <div className="empty">No spots match.</div> : (
              <div className="plan__tablewrap">
                <table className="triptable">
                  <thead><tr><th></th><th>Spot</th><th>Distance</th><th>Next good light</th><th>Alignment</th></tr></thead>
                  <tbody>
                    {filteredRows.map((r) => (
                      <tr key={r.spot.id} className={plan?.id === r.spot.id ? 'active' : ''}>
                        <td><button onClick={() => set({ spot: r.spot.id, at: null, tab: 'rec' })}>Plan</button></td>
                        <td><Link to={`/?spot=${r.spot.id}`}>{r.spot.name}</Link></td>
                        <td>{r.km.toFixed(1)} km</td>
                        <td>{r.good ? `${PHASE_LABEL[r.good.phase]} · ${when(r.good.start)}–${hhmm(r.good.end)}` : '—'}</td>
                        <td>{r.align ? `${r.align.body === 'sun' ? '☀' : '☾'} ${when(r.align.start)} · ${Math.round(r.align.azimuth)}°` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {plan && (
        <article className="plan__print print-only" aria-hidden>
          <h1>{plan.name}</h1>
          <div className="plan__printhead">
            <img src={tileUrl(plan.lat, plan.lng)} alt="" width={128} height={128} />
            <div>
              <p><strong>{plan.lat.toFixed(5)}, {plan.lng.toFixed(5)}</strong>{plan.facingDeg != null ? ` · facing ${Math.round(plan.facingDeg)}°` : ''}</p>
              <p><strong>Shoot:</strong> {when(focus)}{focusRec ? `–${hhmm(focusRec.end)}` : ''}</p>
              {focusRec && <p>{focusRec.reasons.join(' · ')} ({focusRec.confidence} confidence)</p>}
              <p>Looking for: {criteria.map((c) => CRITERIA.find((x) => x.key === c)?.label).join(', ')}</p>
            </div>
          </div>
          <h2>Sun &amp; moon · {dayLabel(focusDay)}</h2>
          <p>Sunrise {rs?.sunrise ? `${hhmm(rs.sunrise.time)} (${Math.round(rs.sunrise.azimuth)}°)` : '—'} · Sunset {rs?.sunset ? `${hhmm(rs.sunset.time)} (${Math.round(rs.sunset.azimuth)}°)` : '—'} · {mp.name}, {Math.round(mp.fraction * 100)}% lit</p>
          {daySteps.length > 0 && <ul>{bestWindows(daySteps).map((w) => <li key={w.start.getTime()}>{WINDOW_LABEL[w.kind]} {hhmm(w.start)}–{hhmm(w.end)}</li>)}</ul>}
          <h2>Weather at {hhmm(focus)}</h2>
          <p>{focusWx ? `${Math.round(focusWx.tempC)}°C · cloud ${Math.round(focusWx.cloudPct)}% (low ${Math.round(focusWx.cloudLowPct)} / mid ${Math.round(focusWx.cloudMidPct)} / high ${Math.round(focusWx.cloudHighPct)}) · rain ${Math.round(focusWx.precipProbPct)}% · wind ${Math.round(focusWx.windKmh)} km/h, gusts ${Math.round(focusWx.gustKmh)}${focusWx.fogLikely ? ' · fog likely' : ''}` : 'No forecast.'}</p>
          <h2>Other good times</h2>
          <ul>{recs.map((r) => <li key={r.t.getTime()}>{when(r.t)}–{hhmm(r.end)}: {r.reasons.join(' · ')}</li>)}</ul>
          {dayPasses.length > 0 && (<><h2>Trains that day</h2><p>{dayPasses.slice(0, 30).map((p) => `${hhmm(p.at)} ${p.label}`).join(' · ')}</p></>)}
          {plan.notes && (<><h2>Notes</h2><p>{plan.notes}</p></>)}
          <p className="hint">{shareUrl()}</p>
        </article>
      )}
    </div>
  );
}

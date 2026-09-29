import { useEffect, useId, useMemo, useState } from 'react';
import {
  displayedSunBearingHits,
  planSunBearing,
  sunBearingSearchStart,
  SUN_BEARING_DEFAULT_WINDOWS,
  SUN_BEARING_RESULT_PREVIEW_COUNT,
  SUN_BEARING_RESULT_LIMIT,
  SUN_BEARING_SEARCH_DAYS,
  type SunBearingPhase,
  type SunBearingPlanHit,
} from '../map/sun.js';
import { hhmm, ymd } from '../time.js';

export interface SunBearingPlannerProps {
  lat: number;
  lng: number;
  defaultBearingDeg: number | null;
  label: string;
  onApplyTime?: (time: Date) => void;
}

const fmtDeg = (n: number) => `${n.toFixed(1)}°`;
const dayLabel = (d: Date) => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function ResultRow({ hit, onApplyTime }: { hit: SunBearingPlanHit; onApplyTime?: (time: Date) => void }) {
  return (
    <li className="sunplan__result">
      <div>
        <strong>{dayLabel(hit.time)} {hhmm(hit.time)}</strong>
        <span className="hint">{hit.phase} · az {fmtDeg(hit.azimuthDeg)} · alt {fmtDeg(hit.altitudeDeg)} · error {fmtDeg(hit.signedErrorDeg)}</span>
      </div>
      {onApplyTime && <button type="button" onClick={() => onApplyTime(hit.time)}>Set time</button>}
    </li>
  );
}

export default function SunBearingPlanner({ lat, lng, defaultBearingDeg, label, onApplyTime }: SunBearingPlannerProps) {
  const resultsId = useId();
  const [bearing, setBearing] = useState(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
  const [bearingEdited, setBearingEdited] = useState(false);
  const [phase, setPhase] = useState<SunBearingPhase>('both');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setBearingEdited(false);
    setBearing(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
    setExpanded(false);
  }, [lat, lng, label]);

  useEffect(() => {
    if (!bearingEdited) {
      setBearing(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
      setExpanded(false);
    }
  }, [bearingEdited, defaultBearingDeg]);

  const bearingNum = Number(bearing);
  const today = ymd(new Date());
  const results = useMemo(() => {
    if (!Number.isFinite(bearingNum)) return [];
    return planSunBearing({
      lat,
      lng,
      bearingDeg: bearingNum,
      phase,
      startDate: sunBearingSearchStart(new Date()),
      days: SUN_BEARING_SEARCH_DAYS,
      ...SUN_BEARING_DEFAULT_WINDOWS,
    }).sort((a, b) => a.absoluteErrorDeg - b.absoluteErrorDeg).slice(0, SUN_BEARING_RESULT_LIMIT);
  }, [lat, lng, bearingNum, phase, today]);
  const visibleResults = displayedSunBearingHits(results, expanded);
  const canToggleResults = results.length > SUN_BEARING_RESULT_PREVIEW_COUNT;

  return (
    <section className="sunplan" aria-label={label}>
      <h4>{label}</h4>
      <div className="sunplan__grid">
        <label>Bearing
          <input type="number" inputMode="decimal" min={0} max={359.999} step={0.1} value={bearing}
            onChange={(e) => { setBearingEdited(true); setExpanded(false); setBearing(e.target.value); }} aria-label="Exact sun bearing in degrees" />
        </label>
        <label>Phase
          <select value={phase} onChange={(e) => { setExpanded(false); setPhase(e.target.value as SunBearingPhase); }} aria-label="Sunrise, sunset, or both">
            <option value="both">Both</option>
            <option value="sunrise">Sunrise</option>
            <option value="sunset">Sunset</option>
          </select>
        </label>
      </div>
      <p className="hint">Choose an exact compass bearing. Results search the next 365 days from today and are ordered by closest angular match.</p>
      {!Number.isFinite(bearingNum) ? <p className="hint">Enter a compass bearing.</p> : results.length === 0 ? <p className="hint">No sunrise or sunset window in the next 365 days.</p> : (
        <>
          <p className="hint"><strong>Closest alignment:</strong> {dayLabel(results[0].time)} {hhmm(results[0].time)} · {fmtDeg(results[0].absoluteErrorDeg)} error</p>
          <ol id={resultsId} className="plainlist sunplan__results">
          {visibleResults.map((hit) => <ResultRow key={`${hit.phase}-${hit.time.getTime()}`} hit={hit} onApplyTime={onApplyTime} />)}
          </ol>
          {canToggleResults && (
            <button
              type="button"
              className="sunplan__toggle"
              aria-expanded={expanded}
              aria-controls={resultsId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show less' : `Show more (${results.length - SUN_BEARING_RESULT_PREVIEW_COUNT})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

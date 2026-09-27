import { useMemo } from 'react';
import { dayPhases, moonPhase, moonUpBands, PHASE_COLOR, PHASE_LABEL, sunriseSunset } from '../map/sun.js';
import { hhmm } from '../time.js';

/** The day's light phases and when the moon is up, with a marker at `time`. */
export default function DayStrip({ lat, lng, time, compact }: { lat: number; lng: number; time: Date; compact?: boolean }) {
  const dayKey = time.toDateString();
  const { bands, moon, rs, start, span } = useMemo(() => {
    const bands = dayPhases(time, lat, lng);
    return {
      bands,
      moon: moonUpBands(time, lat, lng),
      rs: sunriseSunset(time, lat, lng),
      start: bands[0].start.getTime(),
      span: bands.at(-1)!.end.getTime() - bands[0].start.getTime(),
    };
  }, [dayKey, lat, lng]); // per day, not per minute
  const pct = (d: Date) => `${((d.getTime() - start) / span) * 100}%`;
  const width = (a: Date, b: Date) => `${((b.getTime() - a.getTime()) / span) * 100}%`;
  const mp = moonPhase(time);

  return (
    <div className={`daystrip${compact ? ' daystrip--compact' : ''}`}>
      <div className="daystrip__row">
        {bands.map((b) => (
          <div key={b.start.getTime()} className="daystrip__band" style={{ left: pct(b.start), width: width(b.start, b.end), background: PHASE_COLOR[b.phase] }}
            title={`${PHASE_LABEL[b.phase]} ${hhmm(b.start)}–${hhmm(b.end)}`} />
        ))}
        <div className="daystrip__now" style={{ left: pct(time) }} />
      </div>
      <div className="daystrip__row daystrip__row--moon" title={`${mp.name}, ${Math.round(mp.fraction * 100)}% lit`}>
        {moon.map((b) => (
          <div key={b.start.getTime()} className="daystrip__band" style={{ left: pct(b.start), width: width(b.start, b.end), opacity: 0.25 + mp.fraction * 0.75 }} />
        ))}
      </div>
      {!compact && (
        <div className="daystrip__legend">
          <span>☀ {rs.sunrise ? hhmm(rs.sunrise.time) : '—'} ({rs.sunrise ? Math.round(rs.sunrise.azimuth) : '—'}°)</span>
          <span>☾ {mp.name}</span>
          <span>{rs.sunset ? hhmm(rs.sunset.time) : '—'} ({rs.sunset ? Math.round(rs.sunset.azimuth) : '—'}°) ☀</span>
        </div>
      )}
    </div>
  );
}

import { useMemo } from 'react';
import { dayPhases, moonPhase, moonPos, PHASE_COLOR, PHASE_LABEL, phaseAt, sunPos } from '../map/sun.js';
import { hhmm, useMapTime, ymd } from '../time.js';

/** Date picker, Now button and a slider over the selected day with its sun phases drawn on the track. */
export default function TimeBar({ lat, lng }: { lat: number; lng: number }) {
  const { time, live, setTime, goLive } = useMapTime();
  const dayStart = new Date(time.getFullYear(), time.getMonth(), time.getDate());
  const dayKey = dayStart.getTime();
  const rLat = Math.round(lat * 20) / 20; // bands barely move within ~5 km
  const rLng = Math.round(lng * 20) / 20;

  const gradient = useMemo(() => {
    const bands = dayPhases(new Date(dayKey), rLat, rLng);
    const span = bands.at(-1)!.end.getTime() - dayKey;
    const stops = bands.map((b) => {
      const a = ((b.start.getTime() - dayKey) / span) * 100;
      const z = ((b.end.getTime() - dayKey) / span) * 100;
      return `${PHASE_COLOR[b.phase]} ${a}% ${z}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [dayKey, rLat, rLng]);

  const minutes = time.getHours() * 60 + time.getMinutes();
  const sun = sunPos(time, lat, lng);
  const moon = moonPos(time, lat, lng);
  const phase = phaseAt(time, lat, lng);

  return (
    <div className="timebar">
      <div className="timebar__top">
        <input type="date" value={ymd(time)} onChange={(e) => {
          if (!e.target.value) return;
          const [y, m, d] = e.target.value.split('-').map(Number);
          setTime(new Date(y, m - 1, d, time.getHours(), time.getMinutes()));
        }} />
        <button className={live ? 'active' : ''} onClick={goLive} title="Follow the clock">{live ? '● Live' : 'Now'}</button>
        <span className="timebar__time">{hhmm(time)}</span>
        <span className="timebar__phase" style={{ borderColor: PHASE_COLOR[phase] }}>{PHASE_LABEL[phase]}</span>
        <span className="timebar__meta">
          ☀ {Math.round(sun.azimuth)}° / {sun.altitude.toFixed(1)}° · ☾ {Math.round(moon.azimuth)}° / {moon.altitude.toFixed(0)}° {Math.round(moonPhase(time).fraction * 100)}%
        </span>
      </div>
      <input className="timebar__slider" type="range" min={0} max={24 * 60 - 1} step={5} value={minutes} style={{ background: gradient }}
        aria-label="Time of day"
        onChange={(e) => setTime(new Date(time.getFullYear(), time.getMonth(), time.getDate(), 0, Number(e.target.value)))} />
    </div>
  );
}

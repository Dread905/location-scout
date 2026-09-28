import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

/** The global "map time" every light feature reads. Live mode ticks each minute; scrubbing leaves live mode. */
interface MapTime {
  time: Date;
  live: boolean;
  setTime: (d: Date) => void;
  goLive: () => void;
}

const Ctx = createContext<MapTime | null>(null);

export function TimeProvider({ children }: { children: ReactNode }) {
  const [time, setTimeState] = useState(() => new Date());
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    setTimeState(new Date());
    const id = setInterval(() => setTimeState(new Date()), 60_000);
    return () => clearInterval(id);
  }, [live]);

  const value: MapTime = {
    time,
    live,
    setTime: (d) => { setLive(false); setTimeState(d); },
    goLive: () => setLive(true),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMapTime(): MapTime {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMapTime outside TimeProvider');
  return v;
}

/** `HH:MM` in local time. */
export const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
/** 24h HH:mm for machine values (time inputs, local ISO strings). */
export const hhmm24 = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
/** `YYYY-MM-DD` in local time, for <input type="date">. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

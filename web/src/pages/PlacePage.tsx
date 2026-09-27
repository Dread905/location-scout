import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Photo, Place, Spot } from '../api.js';
import { alignments, goodNow } from '../map/sun.js';
import { useMapTime, ymd } from '../time.js';
import DayStrip from '../components/DayStrip.js';
import { GoodTimesChips } from '../components/GoodTimesEditor.js';
import { Lightbox } from '../components/Photos.js';
import { formatAlignment } from '../components/SpotPanel.js';

/** A place's spots side by side, each with its day strip and next alignment, so you can see which corner works when. */
export default function PlacePage() {
  const { id } = useParams();
  const { time, setTime } = useMapTime();
  const [place, setPlace] = useState<Place | null>(null);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [photos, setPhotos] = useState<Record<string, Photo[]>>({});
  const [open, setOpen] = useState<{ list: Photo[]; i: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    Promise.all([api.place(id), api.spots({ placeId: id })])
      .then(async ([p, s]) => {
        setPlace(p);
        setSpots(s);
        const lists = await Promise.all(s.map((x) => api.spotPhotos(x.id).catch(() => [])));
        setPhotos(Object.fromEntries(s.map((x, i) => [x.id, lists[i]])));
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  if (error) return <div className="page"><p className="status-line error">{error}</p></div>;
  if (!place) return <div className="page"><p className="hint">Loading…</p></div>;

  return (
    <div className="page">
      <div className="placehead">
        <div>
          <h1 className="m-0">{place.name}</h1>
          <p className="hint">{spots.length} spot{spots.length === 1 ? '' : 's'} · <Link to={`/?place=${place.id}`}>Show on map</Link></p>
        </div>
        <input type="date" value={ymd(time)} className="w-auto" onChange={(e) => {
          if (!e.target.value) return;
          const [y, m, d] = e.target.value.split('-').map(Number);
          setTime(new Date(y, m - 1, d, time.getHours(), time.getMinutes()));
        }} />
      </div>
      {place.notes && <p>{place.notes}</p>}
      {place.access && <p className="hint">Access: {place.access}</p>}

      {spots.length === 0 && <div className="empty">No spots in this place yet. Add one from the map.</div>}
      <div className="spotgrid">
        {spots.map((s) => {
          const next = alignments(s, time, 365, 1)[0];
          const list = photos[s.id] ?? [];
          return (
            <div key={s.id} className="spotcard">
              <h3><Link to={`/?spot=${s.id}`}>{s.name}</Link> {goodNow(s, time) && <span className="badge-good">Good now</span>}</h3>
              <p className="hint">{s.facingDeg != null ? `Facing ${Math.round(s.facingDeg)}°` : 'No facing'}</p>
              {list.length > 0 && (
                <div className="photos__grid">
                  {list.slice(0, 4).map((p, i) => <img key={p.id} src={p.thumbUrl} alt={p.caption} onClick={() => setOpen({ list, i })} />)}
                </div>
              )}
              <DayStrip lat={s.lat} lng={s.lng} time={time} />
              <p className="hint spotcard__next">{next ? `Next: ${formatAlignment(next)}` : s.facingDeg != null ? 'No alignment within a year' : ''}</p>
              <GoodTimesChips value={s.goodTimes} />
            </div>
          );
        })}
      </div>
      {open && <Lightbox photos={open.list} index={open.i} onClose={() => setOpen(null)} />}
    </div>
  );
}

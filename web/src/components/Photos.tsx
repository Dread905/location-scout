import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Photo, Spot } from '../api.js';
import { prepareUpload, readExif, PhotoMeta } from '../photos.js';
import { haversineKm } from '../map/geo.js';

export function Lightbox({ photos, index, onClose }: { photos: Photo[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((n) => (n + 1) % photos.length);
      if (e.key === 'ArrowLeft') setI((n) => (n - 1 + photos.length) % photos.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos.length, onClose]);
  const p = photos[i];
  if (!p) return null;
  // Portalled: the map panel is its own stacking context, which would trap it under the time bar.
  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <img src={p.url} alt={p.caption} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox__caption">
        {p.caption || (p.kind === 'taken_here' ? 'Taken here' : 'Of this location')}
        {p.takenAt && <span className="hint"> · {new Date(p.takenAt).toLocaleString()}</span>}
        {photos.length > 1 && <span className="hint"> · {i + 1}/{photos.length}</span>}
      </div>
      {photos.length > 1 && <>
        <button className="lightbox__nav lightbox__nav--prev" onClick={(e) => { e.stopPropagation(); setI((i - 1 + photos.length) % photos.length); }}>‹</button>
        <button className="lightbox__nav lightbox__nav--next" onClick={(e) => { e.stopPropagation(); setI((i + 1) % photos.length); }}>›</button>
      </>}
      <button className="lightbox__close" onClick={onClose}>✕</button>
    </div>,
    document.body,
  );
}

interface Pending { file: File; preview: string; meta: PhotoMeta; kind: Photo['kind']; caption: string }

/**
 * A spot's photos, with upload for editors. A geotagged photo offers to move
 * the spot to where it was taken, or to start a new spot there.
 */
export default function Photos({ spot, canEdit, onMoveSpot, onCreateSpotAt }: {
  spot: Spot;
  canEdit: boolean;
  onMoveSpot: (lat: number, lng: number) => void;
  onCreateSpotAt: (lat: number, lng: number) => Promise<Spot>;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const load = () => api.spotPhotos(spot.id).then(setPhotos).catch(() => setPhotos([]));
  useEffect(() => { void load(); }, [spot.id]);

  function clearPending() {
    pending.forEach((p) => URL.revokeObjectURL(p.preview));
    setPending([]);
    setInputKey((k) => k + 1);
  }

  async function pick(files: FileList | null) {
    if (!files) return;
    clearPending();
    const list = await Promise.all([...files].map(async (file) => ({
      file, preview: URL.createObjectURL(file), meta: await readExif(file), kind: 'taken_here' as const, caption: '',
    })));
    setPending(list);
  }

  async function upload(to: Spot) {
    setError('');
    try {
      for (const [n, p] of pending.entries()) {
        setBusy(`Uploading ${n + 1}/${pending.length}…`);
        const prepared = await prepareUpload(p.file);
        await api.uploadPhoto(to.id, prepared.photo, prepared.thumb, {
          kind: p.kind, caption: p.caption, takenAt: p.meta.takenAt?.toISOString(), w: prepared.w, h: prepared.h,
        });
      }
      clearPending();
      if (to.id === spot.id) await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  const gps = pending.find((p) => p.meta.lat != null)?.meta;
  const gpsKm = gps ? haversineKm(spot.lat, spot.lng, gps.lat!, gps.lng!) : 0;

  async function saveCaption(p: Photo, caption: string) {
    if (caption === p.caption) return;
    const next = await api.updatePhoto(p.id, { caption });
    setPhotos((list) => list.map((x) => (x.id === p.id ? next : x)));
  }

  return (
    <div className="photos">
      {photos.length === 0 && !canEdit && <p className="hint">No photos yet.</p>}
      <div className="photos__grid">
        {photos.map((p, i) => (
          <figure key={p.id} className="photos__item">
            <img src={p.thumbUrl} alt={p.caption} loading="lazy" onClick={() => setOpen(i)} />
            {canEdit ? (
              <>
                <input className="photos__caption" defaultValue={p.caption} placeholder="Caption" onBlur={(e) => void saveCaption(p, e.target.value)} />
                <button className="photos__remove" title="Delete photo" onClick={async () => {
                  if (!confirm('Delete this photo?')) return;
                  await api.deletePhoto(p.id);
                  void load();
                }}>✕</button>
              </>
            ) : p.caption && <figcaption>{p.caption}</figcaption>}
          </figure>
        ))}
      </div>

      {canEdit && (
        <div className="photos__upload">
          <input key={inputKey} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void pick(e.target.files)} disabled={!!busy} />
          {pending.map((p, i) => (
            <div key={p.preview} className="photos__pending">
              <img src={p.preview} alt="" />
              <div className="grow stack-4">
                <input value={p.caption} placeholder="Caption" onChange={(e) => setPending((l) => l.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))} />
                <select value={p.kind} onChange={(e) => setPending((l) => l.map((x, j) => (j === i ? { ...x, kind: e.target.value as Photo['kind'] } : x)))}>
                  <option value="taken_here">Taken from here</option>
                  <option value="of_location">Of this location</option>
                </select>
                <span className="hint">
                  {p.meta.takenAt ? p.meta.takenAt.toLocaleString() : 'No capture date'}
                  {p.meta.lat != null ? ` · GPS ${p.meta.lat.toFixed(5)}, ${p.meta.lng!.toFixed(5)}` : ' · no GPS'}
                </span>
              </div>
            </div>
          ))}
          {gps && gpsKm > 0.02 && (
            <div className="banner mt-8">
              Photo was taken {gpsKm < 1 ? `${Math.round(gpsKm * 1000)} m` : `${gpsKm.toFixed(1)} km`} from this spot.
              <div className="chiprow mt-6">
                <button onClick={() => onMoveSpot(gps.lat!, gps.lng!)}>Move spot here</button>
                <button onClick={async () => upload(await onCreateSpotAt(gps.lat!, gps.lng!))} disabled={!!busy}>Create spot here with these photos</button>
              </div>
            </div>
          )}
          {pending.length > 0 && (
            <div className="chiprow mt-8">
              <button className="primary" onClick={() => void upload(spot)} disabled={!!busy}>{busy || `Upload ${pending.length} to this spot`}</button>
              <button onClick={clearPending} disabled={!!busy}>Cancel</button>
            </div>
          )}
          {error && <p className="status-line error">{error}</p>}
        </div>
      )}
      {open != null && <Lightbox photos={photos} index={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

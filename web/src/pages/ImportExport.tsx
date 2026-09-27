import { useEffect, useState } from 'react';
import { strToU8, zipSync } from 'fflate';
import { api, Remote, Share } from '../api.js';
import { ImportRow, isDuplicate, readImportFile, rowsToFeatureCollection } from '../importers.js';

interface Preview extends ImportRow { include: boolean; dup: boolean }

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function ImportExport() {
  const [rows, setRows] = useState<Preview[]>([]);
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [copied, setCopied] = useState('');

  const loadShares = () => api.shares().then(setShares).catch(() => {});
  const loadRemotes = () => api.remotes().then(setRemotes).catch(() => {});
  useEffect(() => { void loadShares(); void loadRemotes(); }, []);

  async function pick(file: File | undefined) {
    if (!file) return;
    setStatus(null);
    setFileName(file.name);
    try {
      const [parsed, spots, places] = await Promise.all([readImportFile(file), api.spots(), api.places()]);
      setRows(parsed.map((r) => {
        const dup = isDuplicate(r, r.kind === 'place' ? places : spots);
        return { ...r, dup, include: !dup };
      }));
    } catch (err) {
      setRows([]);
      setStatus({ ok: false, text: (err as Error).message });
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await api.importGeoJson(rowsToFeatureCollection(rows.filter((r) => r.include)));
      setStatus({ ok: true, text: `Imported ${result.spots} spots and ${result.places} places.` });
      setRows([]);
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  /** GeoJSON plus every photo, zipped here in the browser. */
  async function exportZip() {
    setBusy(true);
    setStatus(null);
    try {
      const bundle = await fetch(api.exportGeoJsonUrl()).then((r) => r.json());
      const files: Record<string, Uint8Array> = {};
      for (const f of bundle.features) {
        for (const p of (f.properties.photos ?? []) as { url: string; thumbUrl: string }[]) {
          for (const key of ['url', 'thumbUrl'] as const) {
            const name = `photos/${p[key].split('/').slice(-2).join('-')}.webp`;
            const res = await fetch(p[key]);
            files[name] = new Uint8Array(await res.arrayBuffer());
            p[key] = name;
          }
        }
      }
      files['spots.geojson'] = strToU8(JSON.stringify(bundle, null, 2));
      download(new Blob([zipSync(files, { level: 0 })]), `location-scout-${new Date().toISOString().slice(0, 10)}.lscout.zip`);
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const shareUrl = (token: string) => `${location.origin}/api/share/${token}`;
  const included = rows.filter((r) => r.include).length;

  return (
    <div className="page settings">
      <h1>Import and export</h1>

      <section>
        <h2>Import</h2>
        <p className="hint">GeoJSON, GPX, KML, KMZ, CSV (<code>name,lat,lng,notes</code>) or Google Takeout Saved Places JSON. Parsed here in the browser; points become spots, tracks and areas become places.</p>
        <input type="file" accept=".geojson,.json,.gpx,.kml,.kmz,.csv" onChange={(e) => void pick(e.target.files?.[0])} />
        {status && <p className={`status-line ${status.ok ? 'ok' : 'error'}`}>{status.text}</p>}
        {rows.length > 0 && (
          <>
            <p className="hint mt-12">
              {fileName}: {rows.length} found, {rows.filter((r) => r.dup).length} look like duplicates (same name within 50 m) and are unticked.
            </p>
            <div className="tablewrap">
              <table className="triptable">
                <thead><tr><th /><th>Kind</th><th>Name</th><th>Lat, lng</th><th>Notes</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={r.dup ? 'is-dup' : ''}>
                      <td><input type="checkbox" checked={r.include} onChange={() => setRows(rows.map((x, j) => (j === i ? { ...x, include: !x.include } : x)))} /></td>
                      <td>{r.kind}{r.dup && <span className="hint"> (dup)</span>}</td>
                      <td>{r.name}</td>
                      <td>{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</td>
                      <td className="hint">{r.notes.slice(0, 80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chiprow mt-8">
              <button className="primary" disabled={busy || !included} onClick={() => void commit()}>Import {included}</button>
              <button onClick={() => setRows([])}>Cancel</button>
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Export</h2>
        <p className="hint">Everything you own. The zip holds the GeoJSON and every photo, for a full backup or handover.</p>
        <div className="chiprow">
          <a href={api.exportGeoJsonUrl()} download="location-scout.geojson"><button>GeoJSON</button></a>
          <a href={api.exportGpxUrl()} download="location-scout.gpx"><button>GPX</button></a>
          <button onClick={() => void exportZip()} disabled={busy}>{busy ? 'Working…' : '.lscout.zip'}</button>
        </div>
      </section>

      <section>
        <h2>Share links</h2>
        <p className="hint">Another Location Scout adds a link under Remotes and syncs your places, spots and photos. Revoke to cut it off.</p>
        <button onClick={async () => { await api.createShare({}); void loadShares(); }}>+ New share link</button>
        <ul className="plainlist mt-8">
          {shares.map((s) => (
            <li key={s.token} className="feedrow row-center">
              <code className={`grow ellipsis${s.revoked_at ? ' is-revoked' : ''}`}>{shareUrl(s.token)}</code>
              {s.revoked_at ? <span className="hint">revoked</span> : <>
                <button onClick={async () => { await navigator.clipboard.writeText(shareUrl(s.token)); setCopied(s.token); }}>{copied === s.token ? 'Copied' : 'Copy'}</button>
                <button onClick={async () => { if (confirm('Revoke this link?')) { await api.revokeShare(s.token); void loadShares(); } }}>Revoke</button>
              </>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Remotes</h2>
        <p className="hint">Share links from other instances. Synced daily, or now.</p>
        <form className="feedrow" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.addRemote(remoteUrl.trim());
            setRemoteUrl('');
            void loadRemotes();
          } catch (err) { alert((err as Error).message); }
        }}>
          <input value={remoteUrl} placeholder="https://other.example/api/share/…" onChange={(e) => setRemoteUrl(e.target.value)} required />
          <button type="submit">Add</button>
        </form>
        <ul className="plainlist">
          {remotes.map((r) => (
            <li key={r.id} className="feedrow row-center">
              <span className="grow ellipsis">
                {r.url}
                <span className={`status-line status-line--block ${r.last_error ? 'error' : 'ok'}`}>
                  {r.last_error ? r.last_error : r.last_sync ? `Synced ${new Date(r.last_sync).toLocaleString()}` : 'Never synced'}
                </span>
              </span>
              <button onClick={async () => { await api.syncRemote(r.id).catch(() => {}); void loadRemotes(); }}>Sync</button>
              <button onClick={async () => { if (confirm('Remove this remote?')) { await api.deleteRemote(r.id); void loadRemotes(); } }}>Remove</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

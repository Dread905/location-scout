import { FormEvent, useEffect, useState } from 'react';
import { api, GeocodeResult, Role, Settings as SettingsType, User } from '../api.js';

type Area = SettingsType['home'];

export default function Settings({ user }: { user: User | null }) {
  const isAdmin = user?.role === 'admin';
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [geoQuery, setGeoQuery] = useState('');
  const [geoResults, setGeoResults] = useState<GeocodeResult[] | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);

  useEffect(() => { api.settings().then(setDraft).catch((err) => setError((err as Error).message)); }, []);
  if (!draft) return <div className="page">{error ? <p className="status-line error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  const set = (patch: Partial<SettingsType>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
    setDirty(true);
  };

  const searchCity = async () => {
    if (!geoQuery.trim()) return;
    setGeoBusy(true);
    try {
      setGeoResults(await api.geocode(geoQuery));
    } catch (err) {
      alert(`Geocoding failed: ${(err as Error).message}`);
    } finally {
      setGeoBusy(false);
    }
  };

  const save = async () => {
    setError('');
    try {
      setDraft(await api.saveSettings(draft));
      setSaved(true);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const fromResult = (r: GeocodeResult, radiusKm: number): Area => ({ name: r.displayName.split(',')[0], lat: r.lat, lng: r.lng, radiusKm });
  const setArea = (i: number, patch: Partial<Area>) => set({ areas: draft.areas.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  return (
    <div className="page settings">
      <h1>Settings</h1>
      {!isAdmin && <div className="banner">Only an admin can change these.</div>}
      <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
        <section>
          <h2>📍 Home</h2>
          <p className="hint">The map opens here, and feeds and the trip planner search around it. Powered by OpenStreetMap geocoding.</p>
          <div className="formrow">
            <label>City / area</label>
            <input value={geoQuery} placeholder="e.g. Bathurst NSW" onChange={(e) => setGeoQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void searchCity(); } }} />
            <button onClick={() => void searchCity()} disabled={geoBusy}>{geoBusy ? 'Searching…' : 'Search'}</button>
          </div>
          {geoResults && (
            <div className="geocode-results">
              {geoResults.length === 0 && <span className="hint">No matches found.</span>}
              {geoResults.map((r) => (
                <div key={`${r.lat},${r.lng}`} className="feedrow">
                  <button style={{ flex: 1, textAlign: 'left' }} onClick={() => { set({ home: fromResult(r, draft.home.radiusKm) }); setGeoResults(null); }}>
                    📍 {r.displayName}
                  </button>
                  <button title="Add as an extra area" onClick={() => { set({ areas: [...draft.areas, fromResult(r, 30)] }); setGeoResults(null); }}>+ Area</button>
                </div>
              ))}
            </div>
          )}
          <div className="status-line ok">● Home: {draft.home.name} ({draft.home.lat.toFixed(4)}, {draft.home.lng.toFixed(4)})</div>
          <div className="formrow" style={{ marginTop: 12 }}>
            <label>Radius: {draft.home.radiusKm} km</label>
            <input type="range" min={5} max={300} step={5} value={draft.home.radiusKm} onChange={(e) => set({ home: { ...draft.home, radiusKm: Number(e.target.value) } })} />
          </div>

          <h4 style={{ margin: '14px 0 6px' }}>Extra areas</h4>
          <p className="hint">Places worth the drive, each with its own reach. Search above and choose "+ Area".</p>
          {draft.areas.length === 0 && <p className="hint">None.</p>}
          {draft.areas.map((a, i) => (
            <div className="feedrow" key={i} style={{ alignItems: 'center' }}>
              <input value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} />
              <span className="hint" style={{ whiteSpace: 'nowrap' }}>{a.lat.toFixed(3)}, {a.lng.toFixed(3)}</span>
              <input type="number" min={1} max={500} value={a.radiusKm} style={{ width: 90 }} onChange={(e) => setArea(i, { radiusKm: Number(e.target.value) })} />
              <span className="hint">km</span>
              <button onClick={() => set({ areas: draft.areas.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
        </section>

        <section>
          <h2>🔗 Instance</h2>
          <div className="formrow"><label>Event Scout URL</label>
            <input value={draft.eventScoutUrl} placeholder="http://event-scout:3001" onChange={(e) => set({ eventScoutUrl: e.target.value })} /></div>
          <div className="formrow"><label>Allow sign-up</label>
            <input type="checkbox" checked={draft.allowSignup} onChange={(e) => set({ allowSignup: e.target.checked })} />
            <span className="hint">New accounts are contributors.</span></div>
          <div className="formrow"><label>Private remotes</label>
            <input type="checkbox" checked={draft.allowPrivateRemotes} onChange={(e) => set({ allowPrivateRemotes: e.target.checked })} />
            <span className="hint">Let remotes resolve to LAN addresses.</span></div>
        </section>

        <section>
          <h2>🚂 Freight</h2>
          <p className="hint">Typical speeds for projecting a sighted freight train along the line.</p>
          <div className="formrow"><label>Loaded km/h</label>
            <input type="number" min={10} max={160} value={draft.freightSpeedLoadedKmh} onChange={(e) => set({ freightSpeedLoadedKmh: Number(e.target.value) })} /></div>
          <div className="formrow"><label>Empty km/h</label>
            <input type="number" min={10} max={160} value={draft.freightSpeedEmptyKmh} onChange={(e) => set({ freightSpeedEmptyKmh: Number(e.target.value) })} /></div>
        </section>
      </fieldset>

      {isAdmin && (
        <div className="savebar">
          <button className="primary" onClick={() => void save()} disabled={!dirty}>Save</button>
          <span className="note">{error ? <span className="status-line error">{error}</span> : saved ? 'Saved.' : dirty ? 'Unsaved changes.' : ''}</span>
        </div>
      )}

      {isAdmin && <Users me={user!} />}
    </div>
  );
}

function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('contributor');
  const [error, setError] = useState('');

  const load = () => api.users().then(setUsers).catch((err) => setError((err as Error).message));
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (err) { setError((err as Error).message); }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    await run(() => api.createUser(username, password, role));
    setUsername('');
    setPassword('');
  }

  return (
    <section>
      <h2>👥 Users</h2>
      <table className="triptable">
        <thead><tr><th>User</th><th>Role</th><th>Since</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}{u.id === me.id && <span className="hint"> (you)</span>}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id} style={{ width: 'auto' }} onChange={(e) => void run(() => api.updateUser(u.id, { role: e.target.value as Role }))}>
                  <option value="contributor">contributor</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td className="hint">{new Date(u.created_at).toLocaleDateString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button onClick={() => {
                  const pw = prompt(`New password for ${u.username} (8+ characters)`);
                  if (pw) void run(() => api.updateUser(u.id, { password: pw }));
                }}>Reset password</button>{' '}
                {u.id !== me.id && <button onClick={() => { if (confirm(`Delete ${u.username}?`)) void run(() => api.deleteUser(u.id)); }}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="feedrow" style={{ marginTop: 12 }} onSubmit={add}>
        <input value={username} placeholder="Username" onChange={(e) => setUsername(e.target.value)} required />
        <input type="password" value={password} placeholder="Password (8+)" minLength={8} onChange={(e) => setPassword(e.target.value)} required />
        <select value={role} style={{ width: 'auto' }} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="contributor">contributor</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Add user</button>
      </form>
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}

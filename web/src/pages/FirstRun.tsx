import { FormEvent, useState } from 'react';
import { api } from '../api.js';

/** First run: no users exist yet, so this creates the admin. */
export default function FirstRun({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.setup(username, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page wizard">
      <div className="wizard__head">
        <h1>Set up Location Scout</h1>
      </div>
      <div className="wizard__intro">
        <h2>Create the admin account</h2>
        <p className="hint">You're the first user, so this account gets admin rights.</p>
      </div>
      <form onSubmit={submit} className="narrow-form">
        <div className="formrow"><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
        <div className="formrow"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></div>
        {error && <p className="status-line error">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create admin account'}</button>
      </form>
    </div>
  );
}

import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Login({ allowSignup, onDone }: { allowSignup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(username, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin" style={{ position: 'static', transform: 'none', margin: '80px auto' }}>
      <h2 style={{ marginTop: 0 }}>Sign in</h2>
      <form onSubmit={submit}>
        <div className="formrow"><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></div>
        <div className="formrow"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error && <p className="status-line error">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {allowSignup && <p className="hint" style={{ marginTop: 12 }}>No account? <Link to="/signup">Sign up</Link></p>}
    </div>
  );
}

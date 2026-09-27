import { useEffect, useState } from 'react';
import { Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { api, AuthStatus } from './api.js';
import FirstRun from './pages/FirstRun.js';
import Login from './pages/Login.js';
import Signup from './pages/Signup.js';
import Spots from './pages/Spots.js';

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = () => api.authStatus().then(setStatus);
  useEffect(() => { void refresh(); }, []);

  if (!status) return <div className="page"><p className="hint">Loading…</p></div>;

  if (status.needsSetup) {
    return <FirstRun onDone={() => refresh().then(() => navigate('/'))} />;
  }

  // Public mode lets anonymous visitors browse; private mode gates everything.
  const mustSignIn = !status.authed && status.mode === 'private';
  if (mustSignIn || location.pathname === '/login' || location.pathname === '/signup') {
    if (location.pathname === '/signup' && status.allowSignup) {
      return <Signup onDone={() => refresh().then(() => navigate('/'))} />;
    }
    if (!mustSignIn && location.pathname !== '/login') return null;
    return <Login allowSignup={status.allowSignup} onDone={() => refresh().then(() => navigate('/'))} />;
  }

  async function logout() {
    await api.logout();
    await refresh();
    navigate('/login');
  }

  return (
    <>
      <div className="topbar">
        <Link className="logo" to="/">Location<span>Scout</span></Link>
        <nav>
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>Spots</Link>
        </nav>
        {status.authed ? (
          <>
            <span className="meta">{status.user?.username} ({status.user?.role})</span>
            <button onClick={logout}>Sign out</button>
          </>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </div>
      <Routes>
        <Route path="/" element={<Spots />} />
        <Route path="*" element={<Spots />} />
      </Routes>
    </>
  );
}

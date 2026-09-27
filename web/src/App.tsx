import { useEffect, useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, AuthStatus } from './api.js';
import { TimeProvider } from './time.js';
import FirstRun from './pages/FirstRun.js';
import Login from './pages/Login.js';
import Signup from './pages/Signup.js';
import MapPage from './pages/MapPage.js';
import PlacePage from './pages/PlacePage.js';
import PlanShoot from './pages/PlanShoot.js';
import ImportExport from './pages/ImportExport.js';
import Settings from './pages/Settings.js';

const NAV = [['/', 'Map'], ['/plan', 'Plan shoot'], ['/import', 'Import / export'], ['/settings', 'Settings']] as const;

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = () => api.authStatus().then(setStatus);
  useEffect(() => { void refresh(); }, []);
  useEffect(() => setMenuOpen(false), [location.pathname]);

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

  const user = status.authed ? status.user : null;
  const active = (path: string) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path));

  return (
    <TimeProvider>
      <div className="topbar">
        <button className="topbar__burger" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">☰</button>
        <Link className="logo" to="/">Location<span>Scout</span></Link>
        <nav className={menuOpen ? 'is-open' : ''}>
          {NAV.filter(([path]) => user || (path !== '/import' && path !== '/settings')).map(([path, label]) => (
            <Link key={path} to={path} className={active(path) ? 'active' : ''}>{label}</Link>
          ))}
          {user && <span className="topbar__nav-meta">{user.username} ({user.role})</span>}
        </nav>
        {user ? (
          <>
            <span className="meta">{user.username} ({user.role})</span>
            <button onClick={logout}>Sign out</button>
          </>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </div>
      {menuOpen && <div className="topbar__scrim" onClick={() => setMenuOpen(false)} />}
      <Routes>
        <Route path="/places/:id" element={<PlacePage />} />
        <Route path="/plan" element={<PlanShoot />} />
        <Route path="/trip" element={<Navigate to={`/plan${location.search}`} replace />} />
        <Route path="/import" element={<ImportExport />} />
        <Route path="/settings" element={<Settings user={user} />} />
        <Route path="*" element={<MapPage user={user} />} />
      </Routes>
    </TimeProvider>
  );
}

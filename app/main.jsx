/**
 * SARdine router shell.
 *
 * Per S291 / S290: a hash-routed SPA that dispatches to per-workflow pages.
 * `/` → Landing chooser
 * `/explore/gcov` → GCOVExplorer (the legacy explore-everything UI)
 * `/explore/gunw` → GUNWExplorer (S294)
 * `/explore/cog` (S295), `/local` (S295),
 * `/inundation` (S292), `/crop` (S293), `/disturbance` (S293)
 *   → ComingSoon placeholders until the respective phase lands.
 *
 * Backward-compat redirects: legacy `?cog=URL` and `?url=URL` query params
 * at the root land on the right `/explore/*` route so old shared links
 * continue to resolve.
 */
import React, { Component, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Router, Switch, Route, Link, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import './theme/sardine-theme.css';
import Landing from './pages/Landing.jsx';
import GCOVExplorer from './pages/GCOVExplorer.jsx';
import GUNWExplorer from './pages/GUNWExplorer.jsx';
import COGExplorer from './pages/COGExplorer.jsx';
import LocalExplorer from './pages/LocalExplorer.jsx';
import InundationApp from './pages/InundationApp.jsx';
import CropApp from './pages/CropApp.jsx';
import DisturbanceApp from './pages/DisturbanceApp.jsx';

// Build metadata injected by Vite `define`. Fallbacks for environments where
// the define isn't present (e.g. a bare `node --eval`).
const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export { BUILD_SHA, APP_VERSION };

/**
 * Dev-only default route (S295). Set VITE_DEFAULT_ROUTE (e.g. "/local") in an
 * `.env.local` to boot into a specific page on page load instead of Landing.
 * Production builds (`import.meta.env.PROD`) ignore this. Skipped when a user
 * already has a hash set, so a shared URL still wins.
 */
function useDevDefaultRoute() {
  const [location, navigate] = useLocation();
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const defaultRoute = import.meta.env.VITE_DEFAULT_ROUTE;
    if (!defaultRoute) return;
    if (location !== '/') return;
    if (window.location.hash && window.location.hash !== '#' && window.location.hash !== '#/') return;
    navigate(defaultRoute, { replace: true });
  }, [location, navigate]);
}

/** Visible on every route — satisfies S290 R8. */
export function BuildChrome() {
  return (
    <div
      className="sardine-build-chrome"
      data-testid="build-chrome"
      style={{
        position: 'fixed',
        bottom: '4px',
        right: '8px',
        fontSize: '10px',
        color: 'var(--sardine-muted, #888)',
        fontFamily: 'monospace',
        zIndex: 999,
        pointerEvents: 'none',
        background: 'rgba(0, 0, 0, 0.3)',
        padding: '2px 6px',
        borderRadius: '3px',
      }}
    >
      v{APP_VERSION} · {BUILD_SHA}
    </div>
  );
}

function ComingSoon({ route, directive }) {
  return (
    <div
      data-testid="coming-soon"
      style={{
        minHeight: '100vh',
        padding: '2rem',
        color: 'var(--sardine-ink, #e0e0e0)',
        fontFamily: 'monospace',
        background: 'var(--sardine-bg, #0f1419)',
      }}
    >
      <h2 style={{ color: 'var(--sardine-cyan, #4ec9d4)' }}>{route} — coming soon</h2>
      <p>
        Planned in directive <code>{directive}</code>.
      </p>
      <p>
        <Link href="/">← Back to chooser</Link>
      </p>
    </div>
  );
}

/**
 * One-shot redirect for legacy `?cog=` / `?url=` root-level links.
 *
 * If a user lands on `/` with a `?url=...` query param (from an old shared
 * link), route them to the appropriate `/explore/*` page and keep the URL
 * so the destination page can auto-load. Extension-based dispatch because
 * we don't want to HEAD-fetch the URL just to classify it.
 */
function useLegacyRedirect() {
  const [location, navigate] = useLocation();
  useEffect(() => {
    // Only redirect from the root. If a hash target is already present, the
    // user's on a real route and legacy params aren't ours to interpret.
    if (location !== '/') return;
    const params = new URLSearchParams(window.location.search);
    const cog = params.get('cog');
    const url = params.get('url');
    if (cog) {
      navigate(`/explore/cog?url=${encodeURIComponent(cog)}`, { replace: true });
      return;
    }
    if (url) {
      const lower = url.toLowerCase().split('?')[0];
      // S294: distinguish GUNW from GCOV by filename substring. NISAR L2
      // filenames carry `_GUNW_` vs `_GCOV_` (and legacy `_unw_`).
      const isH5 = lower.endsWith('.h5') || lower.endsWith('.h5.xz');
      const isGunw = isH5 && (lower.includes('gunw') || lower.includes('_unw_'));
      const route = isGunw
        ? '/explore/gunw'
        : isH5
          ? '/explore/gcov'
          : lower.endsWith('.tif') || lower.endsWith('.tiff')
            ? '/explore/cog'
            : '/explore/gcov';
      navigate(`${route}?url=${encodeURIComponent(url)}`, { replace: true });
    }
  }, [location, navigate]);
}

function Routes() {
  useLegacyRedirect();
  useDevDefaultRoute();
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/explore/gcov" component={GCOVExplorer} />
      <Route path="/explore/gunw" component={GUNWExplorer} />
      <Route path="/explore/cog" component={COGExplorer} />
      <Route path="/inundation" component={InundationApp} />
      <Route path="/crop" component={CropApp} />
      <Route path="/disturbance" component={DisturbanceApp} />
      <Route path="/local" component={LocalExplorer} />
      <Route>{() => <ComingSoon route="Not found" directive="—" />}</Route>
    </Switch>
  );
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[SARdine] Uncaught error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: '2rem',
            color: '#e0e0e0',
            background: '#1a1a2e',
            height: '100vh',
            fontFamily: 'monospace',
          }}
        >
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff6b6b' }}>{this.state.error?.message}</pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '0.5rem 1rem', marginTop: '1rem', cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <Router hook={useHashLocation}>
      <Routes />
      <BuildChrome />
    </Router>
  );
}

// Mount (guard against Vite HMR re-execution).
const container = document.getElementById('app');
if (!container._reactRoot) {
  container._reactRoot = createRoot(container);
}
container._reactRoot.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

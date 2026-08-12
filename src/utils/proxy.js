/**
 * Single source of truth for routing external URLs through a CORS proxy.
 *
 * In development (`npm run dev`): uses the Vite dev plugin at
 *   `${origin}/stac-proxy/<encoded url>`
 * No token is needed because the dev proxy is wide open.
 *
 * In production (the hosted Pages build): uses a user-configured Cloudflare
 * Worker at e.g. `https://sardine-edl-proxy.<handle>.workers.dev/proxy`,
 * with the user's own Earthdata Login token attached via query param.
 *
 * If the Pages build has no configured proxy/token, falls back to direct
 * fetch (which works for already-CORS-friendly URLs like Capella Open Data).
 */

const LS_PROXY_URL   = 'sardine.edl.proxyUrl';
const LS_PROXY_TOKEN = 'sardine.edl.token';

// Default Worker URL for the public Pages deployment. Users running their
// own instance can override this in the Earthdata settings panel.
const DEFAULT_PROXY_URL = 'https://sardine-edl-proxy.nicksteiner.workers.dev';

/** Are we running the static Pages build (no dev CORS plugin)? */
export function isHostedBuild() {
  return import.meta.env.VITE_DEPLOY_TARGET === 'github-pages';
}

export function getProxyUrl() {
  try { return localStorage.getItem(LS_PROXY_URL) || DEFAULT_PROXY_URL; }
  catch { return DEFAULT_PROXY_URL; }
}

export function setProxyUrl(value) {
  try { localStorage.setItem(LS_PROXY_URL, value || ''); } catch {}
}

export function getEDLToken() {
  try { return localStorage.getItem(LS_PROXY_TOKEN) || ''; }
  catch { return ''; }
}

export function setEDLToken(token) {
  try { localStorage.setItem(LS_PROXY_TOKEN, token || ''); } catch {}
}

/**
 * Does this URL need to go through a CORS proxy? Same-origin and
 * already-CORS-friendly hosts pass through directly.
 */
function needsProxy(url) {
  try {
    const u = new URL(url);
    if (u.origin === window.location.origin) return false;
    // Known CORS-friendly public hosts — direct fetch works
    const directOK = [
      'capella-open-data.s3.us-west-2.amazonaws.com',
      'capella-open-data.s3.amazonaws.com',
      'sentinel-cogs.s3.us-west-2.amazonaws.com',
      'overturemaps-us-west-2.s3.us-west-2.amazonaws.com',
      // Hugging Face resolve URLs (demo data): CORS * + Range, including
      // the cas-bridge/CDN hosts the resolve endpoint redirects to.
      'huggingface.co',
      'hf.co',
    ];
    if (directOK.some(h => u.hostname.endsWith(h))) return false;
    return true;
  } catch { return false; }
}

/**
 * Rewrite an external URL to go through the appropriate proxy.
 *
 * Dev: `${origin}/stac-proxy/<encoded>`
 * Hosted with token: `${worker}/proxy?url=<encoded>[&t=<token>]`
 * Hosted without token: returns the original URL (best-effort direct fetch)
 *
 * Token transport: prefer the `X-EDL-Token` HEADER (pass
 * `{ tokenInQuery: false }` and add the header to your fetches — the NISAR
 * h5chunk path does this via fetchHeaders). The `&t=` query fallback exists
 * only for fetch paths that can't set custom headers (geotiff.js COG loads,
 * URLFile) — query strings are more likely to end up in intermediary logs,
 * so don't use it where a header is possible.
 */
export function proxyUrl(rawUrl, { tokenInQuery = true } = {}) {
  if (!rawUrl) return rawUrl;
  if (!needsProxy(rawUrl)) return rawUrl;

  if (isHostedBuild()) {
    const base = getProxyUrl();
    const token = getEDLToken();
    if (!base || !token) {
      // No proxy configured — try direct. Will fail with CORS for most DAACs
      // but that's the user's signal to configure the Earthdata panel.
      return rawUrl;
    }
    const sep = base.endsWith('/') ? '' : '/';
    const tokenPart = tokenInQuery ? `&t=${encodeURIComponent(token)}` : '';
    return `${base}${sep}proxy?url=${encodeURIComponent(rawUrl)}${tokenPart}`;
  }

  // Dev: route through Vite's corsProxyPlugin
  return `${window.location.origin}/stac-proxy/${encodeURIComponent(rawUrl)}`;
}

/**
 * Validate a pasted EDL token by calling the Worker's /whoami endpoint.
 * Resolves to { ok: true, username, email } or { ok: false, error }.
 *
 * In dev mode, hits urs.earthdata.nasa.gov directly through the dev proxy.
 */
export async function validateEDLToken(token, proxyBase) {
  if (!token) return { ok: false, error: 'No token provided' };

  let url;
  if (isHostedBuild()) {
    if (!proxyBase) return { ok: false, error: 'No proxy URL configured' };
    const sep = proxyBase.endsWith('/') ? '' : '/';
    url = `${proxyBase}${sep}whoami?t=${encodeURIComponent(token)}`;
  } else {
    // Dev: route through the local plugin
    url = `${window.location.origin}/stac-proxy/${encodeURIComponent('https://urs.earthdata.nasa.gov/api/users/user')}`;
  }

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', ...(isHostedBuild() ? {} : { 'Authorization': `Bearer ${token}` }) },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `${resp.status} ${resp.statusText}: ${text.slice(0, 120)}` };
    }
    const data = await resp.json();
    return {
      ok: true,
      username: data.uid || data.username || data.user_id || '(unknown)',
      email: data.email_address || data.email || '',
      raw: data,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

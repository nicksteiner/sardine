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
  // `storage` only fires in *other* tabs, so panels in this one need their own
  // signal. Without it a token pasted in one panel stays invisible to another.
  try { window.dispatchEvent(new Event('sardine:edl-token')); } catch {}
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
 * Inverse of proxyUrl: recover the upstream URL from a dev
 * (`/stac-proxy/<encoded>`) or Worker (`/proxy?url=<encoded>`) URL.
 * Anything else is returned unchanged. Needed where the upstream path
 * matters — e.g. resolving a VRT's relative SourceFilenames.
 */
export function unproxyUrl(url) {
  if (!url) return url;
  const dev = /\/stac-proxy\/([^?#]+)/.exec(url);
  if (dev) {
    try { return decodeURIComponent(dev[1]); } catch { return url; }
  }
  try {
    const u = new URL(url);
    if (/\/proxy\/?$/.test(u.pathname) && u.searchParams.has('url')) return u.searchParams.get('url');
  } catch { /* not absolute — leave as is */ }
  return url;
}

/**
 * Validate a pasted EDL token.
 *
 * EDL user tokens are RS256 JWTs that describe themselves: `uid`, `iat` and
 * `exp` live in the payload, so the checks that actually help a user — is this
 * a token at all, whose is it, has it expired — need no network call.
 *
 * We deliberately do NOT call `urs.earthdata.nasa.gov/api/users/user`. That
 * endpoint is for registered EDL *applications* and rejects a bare user token
 * with `{"error":"invalid_token","error_description":"The required client id
 * is missing from the request"}` — a 401 that looks exactly like a bad token
 * and sent at least one user chasing a credential problem they did not have.
 * A token that fails there streams DAAC data (HTTP 206) perfectly well.
 *
 * Resolves to { ok: true, username, expiresAt, daysLeft } or { ok: false, error }.
 */
export function validateEDLToken(token) {
  const raw = (token || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { ok: false, error: 'No token provided' };

  const parts = raw.split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `Not a token — expected 3 dot-separated parts, got ${parts.length}. `
           + 'Copy the long token itself, not its name from the token table.',
    };
  }

  let payload;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
  } catch {
    return { ok: false, error: 'Token payload is not readable — it may have been truncated on copy.' };
  }

  if (!payload.exp) return { ok: false, error: 'Token has no expiry claim — not an Earthdata user token.' };

  const expiresAt = new Date(payload.exp * 1000);
  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) {
    return {
      ok: false,
      error: `Token expired ${expiresAt.toISOString().slice(0, 10)}. `
           + 'Generate a new one from your Earthdata profile.',
    };
  }

  return {
    ok: true,
    username: payload.uid || payload.username || '(unknown)',
    expiresAt,
    daysLeft: Math.floor(msLeft / 86400000),
  };
}

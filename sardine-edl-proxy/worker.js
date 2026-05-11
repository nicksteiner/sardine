/**
 * SARdine Earthdata Login proxy — Cloudflare Worker.
 *
 * Mirrors the dev-server CORS proxy in vite.config.js so the hosted SARdine
 * build at nicksteiner.github.io/sardine can stream from NASA DAACs.
 *
 * Threat model (v1):
 *   - Targets are hard-allowlisted (DAAC hostnames + urs.earthdata.nasa.gov)
 *   - Every request must carry an Earthdata Login token
 *   - On redirects that leave the allowlist (signed S3/CloudFront URLs),
 *     the Authorization header is dropped so the token doesn't leak
 *   - CORS is permissive (*) — token validation is the gate
 *
 * Request shape:
 *   GET <worker>/proxy?url=<urlencoded target>
 *   Header: X-EDL-Token: <bearer>            (preferred)
 *     or query param &t=<bearer>             (fallback for fetches that
 *                                              can't set custom headers,
 *                                              e.g. h5chunk's raw fetches)
 *
 * Health check:
 *   GET <worker>/                            → { ok: true, version }
 *
 * Validation helper (used by SARdine "Test token" button):
 *   GET <worker>/whoami                      → forwards to urs.earthdata.nasa.gov/api/users/user
 */

const VERSION = '0.1.0';

// Browser origins allowed to talk to this Worker. Suffix-matched.
// Empty array = wildcard (development).
const ALLOWED_ORIGINS = [
  'https://nicksteiner.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

// Hostnames the Worker will fetch from. Suffix-matched: "asf.alaska.edu"
// matches any subdomain.
const ALLOWED_HOSTS = [
  // ASF DAAC — NISAR, Sentinel-1, ALOS
  'asf.alaska.edu',
  'datapool.asf.alaska.edu',
  'cumulus.asf.alaska.edu',
  // Earthdata Login + token validation
  'urs.earthdata.nasa.gov',
  // Earthdata Cloud (signed-URL targets and DAAC origins)
  'earthdatacloud.nasa.gov',
  'cumulus.asdc.larc.nasa.gov',
  'data.lpdaac.earthdatacloud.nasa.gov',
  'data.podaac.earthdatacloud.nasa.gov',
  'data.gesdisc.earthdatacloud.nasa.gov',
  'data.nsidcdaac.earthdatacloud.nasa.gov',
  'data.ornldaac.earthdatacloud.nasa.gov',
  // OPERA products live across PO.DAAC + LP DAAC
  'opera.jpl.nasa.gov',
  // CMR (catalog API — no auth needed but useful to proxy for CORS)
  'cmr.earthdata.nasa.gov',
  // Signed redirect targets — AWS S3 and CloudFront, allowlisted broadly
  // because the upstream chooses signed hosts dynamically. The token is
  // dropped before we hit these (see followRedirect).
  's3.amazonaws.com',
  's3.us-west-2.amazonaws.com',
  's3.us-east-1.amazonaws.com',
  'cloudfront.net',
];

const MAX_REDIRECTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB safety cap

function resolveOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (ALLOWED_ORIGINS.length === 0) return '*';
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(request, extra = {}) {
  const origin = resolveOrigin(request);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, Accept, X-EDL-Token',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    ...extra,
  };
  // No Origin header (e.g. server-side curl) → no CORS headers needed
  // Disallowed origin → no Access-Control-Allow-Origin → browser blocks it
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request, { 'Content-Type': 'application/json' }),
  });
}

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

function extractToken(request, url) {
  const header = request.headers.get('X-EDL-Token');
  if (header) return header.trim();
  const q = url.searchParams.get('t');
  return q ? q.trim() : null;
}

/**
 * Walk redirects manually so we can decide when to keep or drop the EDL token.
 * The DAAC → EDL → DAAC callback → signed URL flow needs Authorization on the
 * first two hops and *must not* leak it to S3/CloudFront.
 */
async function followRedirect(request, targetUrl, init, redirectsLeft) {
  if (redirectsLeft < 0) {
    return new Response('Too many redirects', { status: 502, headers: corsHeaders(request) });
  }

  const targetHost = new URL(targetUrl).hostname;
  if (!isAllowedHost(targetHost)) {
    return jsonResponse(request, 403, { error: 'Target host not in allowlist', host: targetHost });
  }

  // We follow redirects ourselves
  const fetchInit = { ...init, redirect: 'manual' };
  const upstream = await fetch(targetUrl, fetchInit);

  // Redirect chain
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get('location');
    if (!location) return upstream;

    const nextUrl = new URL(location, targetUrl).toString();
    const nextHost = new URL(nextUrl).hostname;

    // Decide whether to carry Authorization into the next hop. Keep it for
    // EDL (it needs to validate the token) and for hops that remain inside
    // the *.earthdata.nasa.gov family. Drop it everywhere else (signed S3,
    // CloudFront, etc.) so the token never reaches AWS access logs.
    const nextHeaders = new Headers(init.headers);
    const carryAuth =
      nextHost === 'urs.earthdata.nasa.gov' ||
      nextHost.endsWith('.urs.earthdata.nasa.gov') ||
      nextHost.endsWith('.earthdata.nasa.gov') ||
      nextHost.endsWith('.earthdatacloud.nasa.gov');
    if (!carryAuth) nextHeaders.delete('Authorization');

    // 303 collapses to GET
    const nextMethod = upstream.status === 303 ? 'GET' : (init.method || 'GET');

    return followRedirect(request, nextUrl, {
      ...init,
      method: nextMethod,
      headers: nextHeaders,
      body: nextMethod === 'GET' || nextMethod === 'HEAD' ? null : init.body,
    }, redirectsLeft - 1);
  }

  // Final response — rewrap with CORS headers and pass through the body
  const passthroughHeaders = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) passthroughHeaders[k] = v;
  }

  // Body-size cap: if the upstream told us the size and it's over the cap,
  // refuse rather than start streaming.
  const cl = upstream.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return jsonResponse(request, 413, { error: 'Response exceeds 2 GiB safety cap', size: cl });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: corsHeaders(request, passthroughHeaders),
  });
}

async function handleProxy(request, url) {
  const token = extractToken(request, url);
  if (!token) {
    return jsonResponse(request, 401, {
      error: 'Missing Earthdata Login token',
      hint: 'Set X-EDL-Token header or ?t=<token> query param. Generate a token at https://urs.earthdata.nasa.gov',
    });
  }

  const target = url.searchParams.get('url');
  if (!target) return jsonResponse(request, 400, { error: 'Missing ?url= query parameter' });

  let parsed;
  try { parsed = new URL(target); }
  catch { return jsonResponse(request, 400, { error: 'Invalid target URL' }); }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return jsonResponse(request, 400, { error: 'Only http(s) targets allowed' });
  }

  if (!isAllowedHost(parsed.hostname)) {
    return jsonResponse(request, 403, { error: 'Target host not in allowlist', host: parsed.hostname });
  }

  // Build the upstream request. Forward Range (critical for chunked HDF5),
  // Accept, If-Modified-Since. Strip everything else.
  const upstreamHeaders = new Headers();
  upstreamHeaders.set('Authorization', `Bearer ${token}`);
  upstreamHeaders.set('User-Agent', 'SARdine-EDL-Proxy/' + VERSION);
  for (const h of ['range', 'accept', 'if-modified-since', 'if-none-match']) {
    const v = request.headers.get(h);
    if (v) upstreamHeaders.set(h, v);
  }

  const init = {
    method: request.method,
    headers: upstreamHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
  };

  return followRedirect(request, target, init, MAX_REDIRECTS);
}

async function handleWhoami(request, url) {
  const token = extractToken(request, url);
  if (!token) return jsonResponse(request, 401, { error: 'Missing Earthdata Login token' });

  const upstreamHeaders = new Headers({
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'User-Agent': 'SARdine-EDL-Proxy/' + VERSION,
  });

  const upstream = await fetch('https://urs.earthdata.nasa.gov/api/users/user', {
    method: 'GET',
    headers: upstreamHeaders,
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: corsHeaders(request, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' }),
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse(request, 200, {
        ok: true,
        service: 'sardine-edl-proxy',
        version: VERSION,
        endpoints: ['/proxy?url=...', '/whoami'],
        allowedHosts: ALLOWED_HOSTS,
        allowedOrigins: ALLOWED_ORIGINS,
      });
    }

    if (url.pathname === '/proxy') return handleProxy(request, url);
    if (url.pathname === '/whoami') return handleWhoami(request, url);

    return jsonResponse(request, 404, { error: 'Not found', path: url.pathname });
  },
};

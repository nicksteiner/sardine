import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import https from 'node:https';
import http from 'node:http';

/**
 * Vite plugin: CORS proxy for dev server.
 * Proxies /stac-proxy/<encoded-url> to any external URL,
 * forwarding all headers (Range, Authorization, etc.) and streaming
 * the response back. Used for both STAC API calls and HDF5 data fetches.
 */
function corsProxyPlugin() {
  // Presigned-URL cache: origin DAAC URL → { url, ts }. The OAuth redirect
  // chain (DAAC → EDL → DAAC → CloudFront) costs 3 round-trips per request;
  // h5chunk makes hundreds of Range reads per scene. Resolve once, then hit
  // the signed CloudFront URL directly. Presigned URLs last ~1 h; re-resolve
  // on TTL expiry or a 403 (signature expired).
  const signedUrlCache = new Map();
  const SIGNED_TTL_MS = 30 * 60 * 1000;

  // Keep-alive agents: h5chunk issues dozens of concurrent Range reads to the
  // same CloudFront host; without connection reuse every request pays a fresh
  // TLS handshake (~300-500 ms), capping aggregate throughput at ~1 MB/s.
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  /**
   * Make a proxied request, following redirects (301/302/303/307/308).
   *
   * Earthdata OAuth flow: DAAC → EDL OAuth (keep auth) → DAAC callback (with cookies) → signed URL.
   * The proxy maintains cookies across the redirect chain so the EDL session is preserved.
   *
   * ctx: { originUrl, originHost, fromCache, retryHeaders } — identity of the
   * original browser-requested URL, used to populate/invalidate signedUrlCache.
   */
  function proxyRequest(targetUrl, method, headers, body, res, redirectCount = 0, cookieJar = {}, ctx = null) {
    if (redirectCount > 10) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many redirects' }));
      return;
    }

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    // Attach cookies from jar for this domain
    const cookieStr = Object.entries(cookieJar)
      .filter(([domain]) => parsed.hostname.endsWith(domain) || domain === '*')
      .flatMap(([, cookies]) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`))
      .join('; ');
    if (cookieStr) {
      headers = { ...headers, 'Cookie': cookieStr };
    }

    const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
    const proxyReq = transport.request(parsed, { method, headers, agent }, (proxyRes) => {
      const status = proxyRes.statusCode;

      // Collect Set-Cookie headers into the jar
      const setCookies = proxyRes.headers['set-cookie'];
      if (setCookies) {
        const domain = parsed.hostname;
        if (!cookieJar[domain]) cookieJar[domain] = {};
        const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
        for (const sc of arr) {
          const match = sc.match(/^([^=]+)=([^;]*)/);
          if (match) cookieJar[domain][match[1]] = match[2];
        }
      }

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(status) && proxyRes.headers['location']) {
        const location = proxyRes.headers['location'];
        const nextMethod = status === 303 ? 'GET' : method;
        const locationHost = (() => { try { return new URL(location).hostname; } catch { return ''; } })();
        const isEarthdataAuth = locationHost.includes('urs.earthdata.nasa.gov');
        const isOriginalDaac = locationHost === parsed.hostname || locationHost.includes('earthdatacloud.nasa.gov');

        // Build headers for the next hop:
        // - To EDL OAuth: keep Authorization (EDL needs to validate the Bearer token)
        // - Back to DAAC: keep cookies (EDL sets session cookies), drop Authorization
        // - To signed URL (CloudFront/S3): strip both auth and cookies, keep Range
        const nextHeaders = {};
        if (headers['Range']) nextHeaders['Range'] = headers['Range'];
        if (headers['Accept']) nextHeaders['Accept'] = headers['Accept'];

        if (isEarthdataAuth) {
          // Keep auth for EDL — it needs to validate the Bearer token
          if (headers['Authorization']) nextHeaders['Authorization'] = headers['Authorization'];
        } else if (isOriginalDaac) {
          // Back to DAAC — cookies carry the session, no need for Authorization
        }
        // For signed URLs (CloudFront, S3): no auth needed

        const rangeInfo = headers['Range'] ? ` [${headers['Range']}]` : '';
        const authInfo = nextHeaders['Authorization'] ? ' [+auth]' : '';
        const cookieInfo = cookieStr ? ' [+cookies]' : '';
        console.log(`[cors-proxy] ${method} ${targetUrl.slice(0, 80)}${rangeInfo} → ${status} → ${location.slice(0, 80)}${authInfo}${cookieInfo}`);

        // Landed on a signed URL (not EDL, not the DAAC itself) — cache it so
        // subsequent Range reads for the same origin URL skip the OAuth chain.
        if (ctx && !isEarthdataAuth && !isOriginalDaac && locationHost && locationHost !== ctx.originHost) {
          signedUrlCache.set(ctx.originUrl, { url: location, ts: Date.now() });
        }

        // Consume redirect response body before following
        proxyRes.resume();
        proxyRequest(location, nextMethod, nextHeaders, null, res, redirectCount + 1, cookieJar, ctx);
        return;
      }

      // Transient upstream failure (CloudFront occasionally 500s) — one retry.
      // Without this, a failed merged range read poisons every chunk in it.
      if (status >= 500 && ctx && !ctx.retriedTransient && method === 'GET') {
        console.log(`[cors-proxy] transient ${status}, retrying once: ${targetUrl.slice(0, 80)}`);
        proxyRes.resume();
        setTimeout(() => proxyRequest(targetUrl, method, headers, body, res, redirectCount, cookieJar,
          { ...ctx, retriedTransient: true }), 250);
        return;
      }

      // Cached signed URL rejected (expired signature) — invalidate and
      // re-resolve through the full OAuth chain with the original headers.
      if (ctx && ctx.fromCache && (status === 403 || status === 401)) {
        console.log(`[cors-proxy] cached signed URL expired (${status}), re-resolving ${ctx.originUrl.slice(0, 80)}`);
        signedUrlCache.delete(ctx.originUrl);
        proxyRes.resume();
        proxyRequest(ctx.originUrl, method, ctx.retryHeaders, body, res, 0, {}, { ...ctx, fromCache: false });
        return;
      }

      // Non-redirect: stream response back to browser
      const resHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, Accept',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      };
      if (proxyRes.headers['content-type']) resHeaders['Content-Type'] = proxyRes.headers['content-type'];
      if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) resHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

      const rangeInfo = headers['Range'] ? ` [${headers['Range']}]` : '';
      console.log(`[cors-proxy] ${method} ${targetUrl.slice(0, 80)}${rangeInfo} → ${status}`);

      res.writeHead(status, resHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[cors-proxy] Error: ${targetUrl}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }

  return {
    name: 'cors-proxy',
    configureServer(server) {
      server.middlewares.use('/stac-proxy', (req, res) => {
        // Handle CORS preflight first
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, Accept',
            'Access-Control-Max-Age': '86400',
          });
          res.end();
          return;
        }

        const targetUrl = decodeURIComponent(req.url.slice(1));
        if (!targetUrl || !targetUrl.startsWith('http')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid target URL' }));
          return;
        }

        // Collect request body (for POST)
        const bodyChunks = [];
        req.on('data', (chunk) => bodyChunks.push(chunk));
        req.on('end', () => {
          const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null;

          // Forward relevant headers
          const headers = {};
          if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
          if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
          if (req.headers['range']) headers['Range'] = req.headers['range'];
          if (req.headers['accept']) headers['Accept'] = req.headers['accept'];
          if (body) headers['Content-Length'] = body.length;

          const authDebug = headers['Authorization'] ? `Bearer ${headers['Authorization'].slice(7, 15)}...` : 'none';

          const ctx = {
            originUrl: targetUrl,
            originHost: (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })(),
            fromCache: false,
            retryHeaders: headers,
          };

          // Signed-URL fast path: skip the OAuth redirect chain entirely.
          const cached = signedUrlCache.get(targetUrl);
          if (cached && Date.now() - cached.ts < SIGNED_TTL_MS && (req.method || 'GET') === 'GET') {
            const directHeaders = { ...headers };
            delete directHeaders['Authorization']; // signed URLs must not see the token
            proxyRequest(cached.url, 'GET', directHeaders, body, res, 0, {}, { ...ctx, fromCache: true });
            return;
          }

          console.log(`[cors-proxy] → ${req.method} ${targetUrl.slice(0, 80)} auth=${authDebug}`);
          proxyRequest(targetUrl, req.method || 'GET', headers, body, res, 0, {}, ctx);
        });
      });
    },
  };
}

/**
 * Vite plugin: deep-link dev fix (W008). `?url` is a reserved Vite import
 * query (`import x from './x?url'`), so the dev server rejects any page
 * navigation carrying a `?url=` deep-link param with a 403 ("outside of Vite
 * serving allow list"). Strip the query string from HTML navigation requests
 * server-side before Vite's internal middlewares see it — the browser keeps
 * the full URL, so the app still reads the params from location.search.
 * Production builds serve static index.html and are unaffected.
 */
function deepLinkDevFixPlugin() {
  return {
    name: 'deep-link-dev-fix',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const q = req.url.indexOf('?');
        if (q !== -1 && (req.headers.accept || '').includes('text/html')
            && new URLSearchParams(req.url.slice(q + 1)).has('url')) {
          req.url = req.url.slice(0, q);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), corsProxyPlugin(), deepLinkDevFixPlugin()],
  base: './',   // Relative paths for JupyterHub proxy
  root: 'app',
  resolve: {
    alias: {
      'sardine': '/src/index.js',
      '@src': '/src',
    },
  },
  server: {
    host: '0.0.0.0',  // Listen on all interfaces for JupyterHub proxy
    port: 5173,
    open: false,  // Disable auto-open for headless/Jupyter environments
    allowedHosts: ['.jpl.nasa.gov'],  // Allow JupyterHub proxy domain
    proxy: {
      // Forward API requests to sardine-launch server during development
      '/api': {
        target: 'http://localhost:8050',
        changeOrigin: true,
      },
      '/data': {
        target: 'http://localhost:8050',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});

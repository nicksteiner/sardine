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
  /**
   * Make a proxied request, following redirects (301/302/303/307/308).
   *
   * Earthdata OAuth flow: DAAC → EDL OAuth (keep auth) → DAAC callback (with cookies) → signed URL.
   * The proxy maintains cookies across the redirect chain so the EDL session is preserved.
   */
  function proxyRequest(targetUrl, method, headers, body, res, redirectCount = 0, cookieJar = {}) {
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

    const proxyReq = transport.request(parsed, { method, headers }, (proxyRes) => {
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

        // Consume redirect response body before following
        proxyRes.resume();
        proxyRequest(location, nextMethod, nextHeaders, null, res, redirectCount + 1, cookieJar);
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
          console.log(`[cors-proxy] → ${req.method} ${targetUrl.slice(0, 80)} auth=${authDebug}`);

          proxyRequest(targetUrl, req.method || 'GET', headers, body, res);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), corsProxyPlugin()],
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

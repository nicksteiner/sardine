/**
 * agent-bridge.cjs — W018 Phase 1: the agent bridge broker (read-only).
 *
 * A browser tab cannot be dialed into: connections only originate from the
 * page. So Claude and the viewer both connect *to* this broker, which relays
 * between them.
 *
 *   Claude ──stdio/MCP──▶ [broker] ──SSE push──▶ browser tab
 *                            ▲                       │
 *                            └───── POST reply ──────┘
 *
 * Transport is Server-Sent Events + POST rather than WebSocket: Node ships a
 * WebSocket *client* but no server, and `ws` would be a new dependency in a
 * repo that just dropped seven. SSE is built into every browser (EventSource)
 * and needs nothing but node:http, so the bridge costs zero dependencies.
 *
 * Phase 1 is READ-ONLY: the browser answers questions about itself
 * (view state, a screenshot) and nothing writes into app state.
 *
 * Security: binds 127.0.0.1 only, no auth — it is a local dev tool, but it
 * can address a viewer holding Earthdata credentials, so it must never be
 * exposed. State travels over this channel; secrets never do (same rule the
 * deep links follow).
 */

const http = require('node:http');

const DEFAULT_PORT = 8788;
const REQUEST_TIMEOUT_MS = 15000;

function createAgentBridge(opts = {}) {
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;

  // The connected browser tab's open SSE response stream (at most one; a
  // second tab replaces the first, which is what you want when reloading).
  let viewer = null;
  // In-flight commands awaiting a browser reply: id → {resolve, reject, timer}.
  const pending = new Map();
  let nextId = 1;

  /** Push a command to the viewer and resolve with its reply. */
  function send(cmd, params = {}) {
    return new Promise((resolve, reject) => {
      if (!viewer) {
        reject(new Error('No SARdine viewer connected. Open the app in a browser first.'));
        return;
      }
      const id = String(nextId++);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Viewer did not respond to "${cmd}" within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        viewer.write(`data: ${JSON.stringify({ id, cmd, params })}\n\n`);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`Failed to reach viewer: ${err.message}`));
      }
    });
  }

  function settle(id, payload) {
    const entry = pending.get(id);
    if (!entry) return; // already timed out
    clearTimeout(entry.timer);
    pending.delete(id);
    if (payload && payload.error) entry.reject(new Error(payload.error));
    else entry.resolve(payload ? payload.result : null);
  }

  function readBody(req, limitBytes = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        // Screenshots are the large payload here; cap to avoid unbounded RAM.
        if (size > limitBytes) { reject(new Error('Payload too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /**
   * Handle a bridge request. Returns true if the request was consumed, so
   * this can be mounted inside an existing server (vite dev, launch.cjs).
   */
  async function handleRequest(req, res) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/__agent-bridge/')) return false;

    // Viewer opens this and holds it open; commands stream down it.
    if (url === '/__agent-bridge/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      if (viewer && viewer !== res) { try { viewer.end(); } catch (_) {} }
      viewer = res;
      const keepAlive = setInterval(() => {
        // Comment frames keep proxies from closing an idle stream.
        try { res.write(': ping\n\n'); } catch (_) {}
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        if (viewer === res) viewer = null;
      });
      return true;
    }

    // Viewer posts command results back here.
    if (url === '/__agent-bridge/reply' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (body && body.id) settle(String(body.id), body);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return true;
    }

    // Agent-facing: is a viewer there?
    if (url === '/__agent-bridge/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: !!viewer, pending: pending.size }));
      return true;
    }

    // Agent-facing: run one command against the viewer.
    if (url === '/__agent-bridge/command' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bad request body: ${err.message}` }));
        return true;
      }
      try {
        const result = await send(body.cmd, body.params || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));
      } catch (err) {
        // 503: the viewer is absent or silent — a transport condition the
        // caller can act on, distinct from a malformed request.
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown agent-bridge route' }));
    return true;
  }

  /** Run standalone (production / non-vite use). */
  function listen(port = DEFAULT_PORT, host = '127.0.0.1') {
    const server = http.createServer(async (req, res) => {
      if (!(await handleRequest(req, res))) {
        res.writeHead(404).end();
      }
    });
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  }

  return {
    handleRequest,
    listen,
    send,
    isConnected: () => !!viewer,
    close: () => {
      for (const [, e] of pending) { clearTimeout(e.timer); e.reject(new Error('Bridge closed')); }
      pending.clear();
      if (viewer) { try { viewer.end(); } catch (_) {} viewer = null; }
    },
  };
}

module.exports = { createAgentBridge, DEFAULT_PORT };

// Standalone: node server/agent-bridge.cjs [port]
if (require.main === module) {
  const port = Number(process.argv[2]) || DEFAULT_PORT;
  createAgentBridge().listen(port).then(() => {
    console.log(`[agent-bridge] listening on http://127.0.0.1:${port}`);
  });
}

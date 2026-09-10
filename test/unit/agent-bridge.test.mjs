/**
 * agent-bridge.test.mjs — W018 Phase 1 broker behaviour.
 *
 * Exercises the broker over real HTTP with a simulated browser (an SSE
 * reader that POSTs replies), so the transport is tested as it actually
 * runs rather than through mocks.
 */

import { createRequire } from 'node:module';
import http from 'node:http';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { createAgentBridge } = require('../../server/agent-bridge.cjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ PASS  ${name}`); passed++; }
  catch (err) { console.log(`  ✗ FAIL  ${name}\n          ${err.message}`); failed++; }
}

/** Start a broker on an ephemeral port. */
async function startBridge(opts) {
  const bridge = createAgentBridge(opts);
  const server = await bridge.listen(0);
  const { port } = server.address();
  return { bridge, server, port };
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
      });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    }).on('error', reject);
  });
}

/**
 * Simulated browser tab: holds the SSE stream open and answers commands
 * with `handler`, mirroring agent-bridge-client.js.
 */
function connectFakeViewer(port, handler) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__agent-bridge/events' }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue; // ': ping' keep-alive
          const msg = JSON.parse(line.slice(6));
          Promise.resolve()
            .then(() => handler(msg))
            .then((result) => post(port, '/__agent-bridge/reply', { id: msg.id, result }))
            .catch((err) => post(port, '/__agent-bridge/reply', { id: msg.id, error: err.message }));
        }
      });
      resolve({ close: () => req.destroy() });
    });
  });
}

console.log('\nagent-bridge (W018 Phase 1)\n');

await test('command round-trips to a connected viewer', async () => {
  const { bridge, server, port } = await startBridge();
  const viewer = await connectFakeViewer(port, (msg) => {
    assert.strictEqual(msg.cmd, 'get_view_state');
    return { colormap: 'viridis', contrastMin: -25 };
  });
  const res = await post(port, '/__agent-bridge/command', { cmd: 'get_view_state' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.result.colormap, 'viridis');
  assert.strictEqual(res.body.result.contrastMin, -25);
  viewer.close(); bridge.close(); server.close();
});

await test('params are forwarded to the viewer', async () => {
  const { bridge, server, port } = await startBridge();
  const viewer = await connectFakeViewer(port, (msg) => ({ got: msg.params.maxDim }));
  const res = await post(port, '/__agent-bridge/command', { cmd: 'screenshot', params: { maxDim: 512 } });
  assert.strictEqual(res.body.result.got, 512);
  viewer.close(); bridge.close(); server.close();
});

await test('no viewer connected → 503 with an actionable message', async () => {
  const { bridge, server, port } = await startBridge();
  const res = await post(port, '/__agent-bridge/command', { cmd: 'get_view_state' });
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /No SARdine viewer connected/);
  bridge.close(); server.close();
});

await test('viewer error propagates as an error, not a result', async () => {
  const { bridge, server, port } = await startBridge();
  const viewer = await connectFakeViewer(port, () => { throw new Error('No canvas available'); });
  const res = await post(port, '/__agent-bridge/command', { cmd: 'screenshot' });
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /No canvas available/);
  viewer.close(); bridge.close(); server.close();
});

await test('silent viewer times out instead of hanging forever', async () => {
  const { bridge, server, port } = await startBridge({ timeoutMs: 250 });
  const viewer = await connectFakeViewer(port, () => new Promise(() => {})); // never replies
  const started = Date.now();
  const res = await post(port, '/__agent-bridge/command', { cmd: 'get_view_state' });
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /did not respond/);
  assert.ok(Date.now() - started < 3000, 'should time out promptly');
  viewer.close(); bridge.close(); server.close();
});

await test('status reports viewer connectivity', async () => {
  const { bridge, server, port } = await startBridge();
  let res = await get(port, '/__agent-bridge/status');
  assert.strictEqual(res.body.connected, false);
  const viewer = await connectFakeViewer(port, () => ({}));
  res = await get(port, '/__agent-bridge/status');
  assert.strictEqual(res.body.connected, true);
  viewer.close(); bridge.close(); server.close();
});

await test('a reconnecting tab replaces the previous stream', async () => {
  const { bridge, server, port } = await startBridge();
  const first = await connectFakeViewer(port, () => ({ from: 'first' }));
  const second = await connectFakeViewer(port, () => ({ from: 'second' }));
  const res = await post(port, '/__agent-bridge/command', { cmd: 'get_view_state' });
  assert.strictEqual(res.body.result.from, 'second');
  first.close(); second.close(); bridge.close(); server.close();
});

await test('non-bridge routes are left for other handlers', async () => {
  const bridge = createAgentBridge();
  let nexted = false;
  const fakeRes = { writeHead() { return this; }, end() {} };
  const handled = await bridge.handleRequest({ url: '/api/health', method: 'GET' }, fakeRes);
  assert.strictEqual(handled, false, 'should not consume unrelated routes');
  bridge.close();
});

console.log(`\nagent-bridge: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

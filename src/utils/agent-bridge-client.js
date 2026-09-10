/**
 * agent-bridge-client.js — W018 Phase 1: browser half of the agent bridge.
 *
 * Connects to the broker (server/agent-bridge.cjs) over EventSource, answers
 * commands from a handler registry, and POSTs results back. Phase 1 handlers
 * are read-only: they report on the viewer, they do not mutate app state.
 *
 * Usage (app/main.jsx):
 *   const bridge = connectAgentBridge();
 *   bridge.register('get_view_state', () => serializeViewerState());
 *   ...
 *   return () => bridge.disconnect();
 *
 * The bridge is optional: if no broker is running, EventSource retries
 * quietly in the background and the viewer behaves exactly as before.
 */

import { debugLog } from './debug-log.js';

const EVENTS_URL = '/__agent-bridge/events';
const REPLY_URL = '/__agent-bridge/reply';

export function connectAgentBridge(opts = {}) {
  const handlers = new Map();
  let source = null;
  let closed = false;

  async function reply(id, payload) {
    try {
      await fetch(REPLY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
    } catch (err) {
      // The broker went away mid-command; EventSource will reconnect.
      debugLog('[agent-bridge] reply failed:', err.message);
    }
  }

  async function dispatch(msg) {
    const { id, cmd, params } = msg;
    const handler = handlers.get(cmd);
    if (!handler) {
      await reply(id, { error: `No handler registered for "${cmd}"` });
      return;
    }
    try {
      const result = await handler(params || {});
      await reply(id, { result });
    } catch (err) {
      await reply(id, { error: err?.message || String(err) });
    }
  }

  function connect() {
    if (closed || typeof EventSource === 'undefined') return;
    source = new EventSource(EVENTS_URL);
    source.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return; // keep-alive comment frames never reach onmessage
      }
      if (msg && msg.id && msg.cmd) dispatch(msg);
    };
    source.onopen = () => debugLog('[agent-bridge] connected');
    source.onerror = () => {
      // EventSource reconnects on its own; nothing to do but note it. This is
      // the normal state when no broker is running, so it must stay quiet.
      debugLog('[agent-bridge] disconnected (will retry)');
    };
  }

  if (opts.autoConnect !== false) connect();

  return {
    register(cmd, fn) { handlers.set(cmd, fn); return this; },
    unregister(cmd) { handlers.delete(cmd); return this; },
    isConnected: () => !!source && source.readyState === 1,
    disconnect() {
      closed = true;
      if (source) { source.close(); source = null; }
    },
  };
}

/**
 * Capture a deck.gl WebGL canvas as a downscaled PNG data URL.
 *
 * Two details matter. The canvas is only readable because SARViewer sets
 * `preserveDrawingBuffer: true`; and deck.gl may have cleared the buffer
 * since the last paint, so callers should redraw() immediately before this.
 * Downscaling keeps a 16k-wide scene from becoming a useless wall of pixels.
 */
export function captureCanvas(canvas, maxDim = 1024) {
  if (!canvas) throw new Error('No canvas available — is a scene loaded?');
  const { width, height } = canvas;
  if (!width || !height) throw new Error('Canvas has zero size');

  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);

  return {
    dataUrl: out.toDataURL('image/png'),
    width: w,
    height: h,
    sourceWidth: width,
    sourceHeight: height,
  };
}

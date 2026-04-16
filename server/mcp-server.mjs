#!/usr/bin/env node
/**
 * mcp-server.mjs — stdio MCP server for sardine (GPU browser viewer).
 *
 * Bridges the viewer's HTTP endpoints (local-file-server.mjs, stac-api.cjs)
 * into MCP JSON-RPC over stdio so the sardine viewer participates in the
 * cross-repo interop fabric alongside sardine-agent and sl-nextflow.
 *
 * Four tools (names mirror skills.json):
 *   - sardine_viewer_stac_search   → DuckDB STAC /api/stac/search
 *   - sardine_viewer_list_files    → local-file-server directory listing
 *   - sardine_viewer_serve_file    → local-file-server URL construction
 *   - sardine_viewer_render_preview→ viewer /api/render (stub)
 *
 * Usage:
 *   node server/mcp-server.mjs
 *   Env: VIEWER_URL (default http://localhost:5173)
 *        FILE_SERVER_URL (default http://localhost:8081)
 *        STAC_API_URL (default $VIEWER_URL/api/stac)
 *
 * Protocol:
 *   - Reads newline-delimited JSON-RPC 2.0 requests on stdin
 *   - Writes newline-delimited JSON-RPC responses on stdout
 *   - Anything else goes to stderr (do NOT corrupt stdout)
 *
 * Minimal MCP subset implemented:
 *   - initialize
 *   - notifications/initialized (no-op)
 *   - tools/list
 *   - tools/call
 */

import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VIEWER_URL = (process.env.VIEWER_URL || 'http://localhost:5173').replace(/\/$/, '');
const FILE_SERVER_URL = (process.env.FILE_SERVER_URL || 'http://localhost:8081').replace(/\/$/, '');
const STAC_API_URL = (process.env.STAC_API_URL || `${VIEWER_URL}/api/stac`).replace(/\/$/, '');
const LOCAL_ROOT = process.env.SARDINE_DATA_ROOT || os.homedir();

const SERVER_INFO = { name: 'sardine-viewer', version: '0.9.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'sardine_viewer_stac_search',
    description: 'Search the viewer\'s DuckDB STAC catalog for SAR scenes. Proxies to the viewer\'s /api/stac/search endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        bbox: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north]' },
        datetime: { type: 'string', description: 'ISO 8601 datetime range' },
        collections: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'sardine_viewer_list_files',
    description: 'List SAR data files visible to the viewer. Tries the local file server first, falls back to direct filesystem reads from SARDINE_DATA_ROOT.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '/' },
        pattern: { type: 'string', description: 'Glob filter pattern (e.g. *.h5)' },
      },
    },
  },
  {
    name: 'sardine_viewer_serve_file',
    description: 'Return an HTTP Range-capable URL for a local HDF5/GeoTIFF file, suitable for streaming with h5chunk or geotiff.js.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to SARDINE_DATA_ROOT' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sardine_viewer_render_preview',
    description: 'Request a preview render from the viewer. Stub — currently returns the deep-link URL; implement server-side rendering to replace.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        colormap: { type: 'string', default: 'viridis' },
        width: { type: 'integer', default: 512 },
        height: { type: 'integer', default: 512 },
      },
      required: ['source'],
    },
  },
];

function log(...args) {
  process.stderr.write(args.map(String).join(' ') + '\n');
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function err(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

async function tryHttpJson(url, { method = 'GET', body, headers } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...(headers || {}) } };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    opts.signal = controller.signal;
    const res = await fetch(url, opts);
    clearTimeout(timer);
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const text = await res.text();
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { data: text };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function toolStacSearch(args) {
  const params = new URLSearchParams();
  if (args.bbox) params.set('bbox', args.bbox.join(','));
  if (args.datetime) params.set('datetime', args.datetime);
  if (args.collections) params.set('collections', args.collections.join(','));
  if (args.limit) params.set('limit', String(args.limit));
  const url = `${STAC_API_URL}/search?${params.toString()}`;
  const { data, error } = await tryHttpJson(url);
  if (error) {
    return {
      status: 'viewer_unreachable',
      reason: error,
      hint: `Start the viewer (npm run dev) or set STAC_API_URL. Tried: ${url}`,
    };
  }
  return data;
}

async function toolListFiles(args) {
  const rel = (args.path || '/').replace(/^\//, '');
  const pattern = args.pattern;

  const url = `${FILE_SERVER_URL}/${rel}`;
  const { data, error } = await tryHttpJson(url);
  if (!error && data) {
    if (pattern && data.entries) {
      const re = globToRegex(pattern);
      data.entries = data.entries.filter(e => re.test(e.name));
    }
    return { source: 'file_server', ...data };
  }

  try {
    const full = path.resolve(LOCAL_ROOT, rel);
    if (!full.startsWith(path.resolve(LOCAL_ROOT))) {
      return { error: 'path traversal denied' };
    }
    const items = await fs.readdir(full, { withFileTypes: true });
    const ALLOWED = new Set(['.h5', '.hdf5', '.he5', '.nc', '.tif', '.tiff']);
    const re = pattern ? globToRegex(pattern) : null;
    const entries = [];
    for (const it of items) {
      if (it.isDirectory()) {
        if (!re || re.test(it.name + '/')) {
          entries.push({ name: it.name + '/', type: 'dir' });
        }
      } else if (ALLOWED.has(path.extname(it.name).toLowerCase())) {
        if (!re || re.test(it.name)) {
          const stat = await fs.stat(path.join(full, it.name));
          entries.push({ name: it.name, type: 'file', size: stat.size });
        }
      }
    }
    return { source: 'local_fs', root: full, entries };
  } catch (e) {
    return { error: `list failed: ${e.message}`, file_server_error: error };
  }
}

async function toolServeFile(args) {
  if (!args.path) return { error: 'path is required' };
  const rel = args.path.replace(/^\//, '');
  const full = path.resolve(LOCAL_ROOT, rel);
  if (!full.startsWith(path.resolve(LOCAL_ROOT))) {
    return { error: 'path traversal denied' };
  }
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return { error: 'not a file' };
    return {
      url: `${FILE_SERVER_URL}/${encodeURI(rel)}`,
      size: stat.size,
      absolute_path: full,
      range_capable: true,
      note: 'Requires local-file-server.mjs to be running on FILE_SERVER_URL.',
    };
  } catch (e) {
    return { error: `file not accessible: ${e.message}` };
  }
}

async function toolRenderPreview(args) {
  if (!args.source) return { error: 'source is required' };
  const qs = new URLSearchParams({
    source: args.source,
    colormap: args.colormap || 'viridis',
    width: String(args.width || 512),
    height: String(args.height || 512),
  });
  return {
    status: 'stub',
    deep_link: `${VIEWER_URL}/?${qs.toString()}`,
    note: 'Server-side rendering is not yet implemented. Open the deep_link in a browser to preview.',
  };
}

function globToRegex(glob) {
  const special = /[.+^${}()|[\]\\]/g;
  const s = glob.replace(special, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${s}$`, 'i');
}

const HANDLERS = {
  sardine_viewer_stac_search: toolStacSearch,
  sardine_viewer_list_files: toolListFiles,
  sardine_viewer_serve_file: toolServeFile,
  sardine_viewer_render_preview: toolRenderPreview,
};

async function dispatch(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    const handler = HANDLERS[name];
    if (!handler) {
      return err(id, -32601, `Unknown tool: ${name}`);
    }
    try {
      const result = await handler(args);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch (e) {
      return err(id, -32603, `Tool execution failed: ${e.message}`);
    }
  }

  if (method === 'ping') return ok(id, {});

  return err(id, -32601, `Method not found: ${method}`);
}

async function main() {
  log(`sardine-viewer MCP server starting (viewer=${VIEWER_URL}, file_server=${FILE_SERVER_URL}, root=${LOCAL_ROOT})`);
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log('parse error:', e.message, 'line:', trimmed.slice(0, 200));
      continue;
    }

    try {
      const response = await dispatch(msg);
      if (response !== null) write(response);
    } catch (e) {
      log('dispatch error:', e.message);
      if (msg.id !== undefined) {
        write(err(msg.id, -32603, `Internal error: ${e.message}`));
      }
    }
  }
}

main().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * sardine-launch — Lightweight server for the NISAR On-Demand JupyterLab system.
 *
 * Serves:
 *   1. The built SARdine frontend (dist/)
 *   2. A file-listing REST API for browsing NISAR data on the local filesystem
 *   3. Byte-range file serving so h5chunk can stream HDF5 chunks over HTTP
 *
 * Usage:
 *   node server/launch.js                         # defaults: /data/nisar, port 8050
 *   node server/launch.js --data-dir /mnt/gcov    # custom data root
 *   node server/launch.js --port 9000             # custom port
 *
 * The DataDiscovery browser connects to:
 *   GET /api/files?prefix=L2_GCOV/          → directory listing (JSON)
 *   GET /data/L2_GCOV/some_file.h5          → file serving with Range support
 */

import { createServer } from 'http';
import { readdir, stat, access, constants } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, resolve, extname, relative, normalize } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(__dirname, '..', 'dist');

// ─── CLI args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dataDir: '/data/nisar',
    port: 8050,
    host: '0.0.0.0',
  };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--data-dir' || args[i] === '-d') && args[i + 1]) {
      opts.dataDir = resolve(args[++i]);
    } else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      opts.port = parseInt(args[++i]);
    } else if ((args[i] === '--host' || args[i] === '-h') && args[i + 1]) {
      opts.host = args[++i];
    } else if (args[i] === '--help') {
      console.log(`
sardine-launch — SARdine server for NISAR On-Demand

Usage:
  node server/launch.js [options]

Options:
  --data-dir, -d <path>   Data directory to serve (default: /data/nisar)
  --port, -p <number>     Port number (default: 8050)
  --host <address>        Bind address (default: 0.0.0.0)
  --help                  Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

// ─── MIME types ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.h5':   'application/x-hdf5',
  '.hdf5': 'application/x-hdf5',
  '.he5':  'application/x-hdf5',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
};

// ─── Security: path traversal guard ─────────────────────────────────────
function safePath(base, requested) {
  const full = normalize(join(base, requested));
  if (!full.startsWith(base)) return null; // traversal attempt
  return full;
}

// ─── File listing API ────────────────────────────────────────────────────
async function handleFileList(dataDir, url, res) {
  const params = new URL(url, 'http://localhost').searchParams;
  const prefix = params.get('prefix') || '';

  const dirPath = safePath(dataDir, prefix);
  if (!dirPath) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  try {
    await access(dirPath, constants.R_OK);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Directory not found' }));
    return;
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    const directories = [];
    const files = [];

    for (const entry of entries) {
      // Skip hidden files
      if (entry.name.startsWith('.')) continue;

      const entryPrefix = prefix ? `${prefix.replace(/\/$/, '')}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        directories.push(entryPrefix + '/');
      } else if (entry.isFile()) {
        try {
          const fileStat = await stat(join(dirPath, entry.name));
          files.push({
            key: entryPrefix,
            size: fileStat.size,
            lastModified: fileStat.mtime.toISOString(),
            etag: '',
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }

    // Sort: directories first (alpha), then files (alpha)
    directories.sort();
    files.sort((a, b) => a.key.localeCompare(b.key));

    const body = JSON.stringify({
      directories,
      files,
      isTruncated: false,
      nextToken: null,
      prefix,
      totalKeys: directories.length + files.length,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Data file serving (with Range support for h5chunk) ──────────────────
async function handleDataFile(dataDir, filePath, req, res) {
  const fullPath = safePath(dataDir, filePath);
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error('Not a file');
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(fullPath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const fileSize = fileStat.size;

  // Handle Range requests (critical for h5chunk streaming)
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    const start = parseInt(match[1]);
    const end = match[2] ? parseInt(match[2]) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    });
    createReadStream(fullPath, { start, end }).pipe(res);
  } else {
    // Full file
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    });
    createReadStream(fullPath).pipe(res);
  }
}

// ─── Static file serving (dist/) ────────────────────────────────────────
async function handleStatic(urlPath, res) {
  // Map / → /index.html
  let filePath = urlPath === '/' ? '/index.html' : urlPath;

  const fullPath = safePath(DIST_DIR, filePath);
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error();

    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStat.size,
      'Cache-Control': filePath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'   // hashed assets
        : 'no-cache',                               // index.html
    });
    createReadStream(fullPath).pipe(res);
  } catch {
    // SPA fallback — serve index.html for unknown routes
    const indexPath = join(DIST_DIR, 'index.html');
    try {
      const indexStat = await stat(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': indexStat.size });
      createReadStream(indexPath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

// ─── Main server ─────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  // Verify data directory exists
  try {
    await access(opts.dataDir, constants.R_OK);
  } catch {
    console.warn(`⚠  Data directory not found: ${opts.dataDir}`);
    console.warn(`   Server will start but /api/files and /data/ will return errors.`);
    console.warn(`   Use --data-dir to point to your NISAR data.\n`);
  }

  // Verify dist exists
  try {
    await access(join(DIST_DIR, 'index.html'), constants.R_OK);
  } catch {
    console.error(`✗  Built frontend not found at ${DIST_DIR}/index.html`);
    console.error(`   Run 'npm run build' first.\n`);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = req.url;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      if (url.startsWith('/api/files')) {
        // File listing API
        await handleFileList(opts.dataDir, url, res);
      } else if (url.startsWith('/data/')) {
        // Serve data files with Range support
        const filePath = decodeURIComponent(url.slice('/data/'.length));
        await handleDataFile(opts.dataDir, filePath, req, res);
      } else {
        // Static frontend
        await handleStatic(decodeURIComponent(url.split('?')[0]), res);
      }
    } catch (e) {
      console.error(`Error handling ${url}:`, e);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`
┌─────────────────────────────────────────────────┐
│  SARdine — SAR Data INspection and Exploration  │
├─────────────────────────────────────────────────┤
│                                                 │
│  Server:    http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}              │
│  Data dir:  ${opts.dataDir.padEnd(36)}│
│                                                 │
│  Routes:                                        │
│    /              → SARdine UI                   │
│    /api/files     → directory listing API        │
│    /data/<path>   → file serving (Range OK)      │
│                                                 │
│  Usage:                                         │
│    1. Open the URL above in your browser        │
│    2. Select "Remote Bucket / S3"               │
│    3. Use preset "SARdine Server (local)"       │
│    4. Browse, filter, click to stream           │
│                                                 │
│  Press Ctrl+C to stop                           │
└─────────────────────────────────────────────────┘
`);
  });
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

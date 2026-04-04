#!/usr/bin/env node
/**
 * Minimal static server for sardine-lite report viewer.
 *
 * Usage:
 *   node src/lite/serve.js                        # serve on port 8111
 *   node src/lite/serve.js 9000                   # custom port
 *   node src/lite/serve.js --open report.json     # open browser with report
 *   node src/lite/serve.js --open http://url.json # open browser with remote report
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
};

// Parse args
const args = process.argv.slice(2);
let port = 8111;
let openReport = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--open' && args[i + 1]) {
    openReport = args[++i];
  } else if (/^\d+$/.test(args[i])) {
    port = Number(args[i]);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let filePath = url.pathname === '/' ? '/report-viewer.html' : url.pathname;
  filePath = join(__dirname, filePath);

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(port, () => {
  const base = `http://localhost:${port}`;
  console.log(`sardine-lite report viewer → ${base}`);

  if (openReport) {
    // If it's a local file path, serve it from /data endpoint
    const isUrl = openReport.startsWith('http://') || openReport.startsWith('https://');
    const reportParam = isUrl ? openReport : `${base}/data/${encodeURIComponent(openReport)}`;

    // If local file, add a /data route
    if (!isUrl) {
      const origHandler = server.listeners('request')[0];
      server.removeAllListeners('request');
      server.on('request', async (req, res) => {
        const u = new URL(req.url, `http://localhost:${port}`);
        if (u.pathname.startsWith('/data/')) {
          const localPath = decodeURIComponent(u.pathname.slice(6));
          try {
            const data = await readFile(localPath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
            return;
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
          }
        }
        origHandler(req, res);
      });
    }

    const viewUrl = `${base}?report=${encodeURIComponent(reportParam)}`;
    console.log(`Opening: ${viewUrl}`);

    // Cross-platform open
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    exec(`${cmd} "${viewUrl}"`);
  }
});

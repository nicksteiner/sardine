import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.argv[2] || os.homedir();
const PORT = parseInt(process.env.PORT || '8081', 10);
const ALLOWED_EXT = new Set(['.h5', '.hdf5', '.he5', '.nc']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
}

function safePath(reqPath) {
  const decoded = decodeURIComponent(reqPath.replace(/^\//, ''));
  const resolved = path.resolve(ROOT, decoded);
  if (!resolved.startsWith(path.resolve(ROOT))) return null; // directory traversal guard
  return resolved;
}

async function handleList(req, res, dirPath) {
  const entries = [];
  try {
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        entries.push({ name: item.name + '/', type: 'dir' });
      } else if (ALLOWED_EXT.has(path.extname(item.name).toLowerCase())) {
        const stat = await fs.promises.stat(path.join(dirPath, item.name));
        entries.push({ name: item.name, type: 'file', size: stat.size });
      }
    }
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ root: dirPath, entries }, null, 2));
}

async function handleFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (stat.isDirectory()) {
    return handleList(req, res, filePath);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    res.writeHead(403);
    res.end('File type not allowed');
    return;
  }

  const total = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');

  // HEAD request — return size info only
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'application/octet-stream',
    });
    res.end();
    return;
  }

  // Range request
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416);
      res.end('Invalid range');
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : total - 1;

    if (start >= total || end >= total || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // Full file (unlikely for large HDF5, but supported)
  res.writeHead(200, {
    'Content-Length': total,
    'Content-Type': 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const filePath = safePath(req.url.split('?')[0]);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  handleFile(req, res, filePath).catch(err => {
    console.error(err);
    res.writeHead(500);
    res.end('Internal error');
  });
});

server.listen(PORT, () => {
  console.log(`\n🐟 SARdine local file server`);
  console.log(`   Root:  ${ROOT}`);
  console.log(`   URL:   http://localhost:${PORT}/`);
  console.log(`\n   Browse files:  http://localhost:${PORT}/`);
  console.log(`\n   If running on an ODS / JupyterHub, use the proxy URL:`);
  console.log(`     https://<your-jupyterlab-host>/user/<username>/proxy/${PORT}/`);
  console.log(`\n   Examples:`);
  console.log(`     node server/local-file-server.mjs ~/ods`);
  console.log(`     PORT=9000 node server/local-file-server.mjs ~/ods\n`);
});

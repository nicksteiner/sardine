#!/usr/bin/env node
/**
 * sardine-launch — Lightweight server for the NISAR On-Demand JupyterLab system.
 *
 * Compatible with Node.js >= 10 (CommonJS, no ESM, no fs/promises).
 * Zero dependencies — uses only Node built-ins.
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

'use strict';

var http = require('http');
var fs   = require('fs');
var path = require('path');
var url  = require('url');

var DIST_DIR = path.resolve(__dirname, '..', 'dist');

// ─── CLI args ────────────────────────────────────────────────────────────
function parseArgs() {
  var args = process.argv.slice(2);
  var opts = {
    dataDir: '/data/nisar',
    port: 8050,
    host: '0.0.0.0',
  };

  for (var i = 0; i < args.length; i++) {
    if ((args[i] === '--data-dir' || args[i] === '-d') && args[i + 1]) {
      opts.dataDir = path.resolve(args[++i]);
    } else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      opts.port = parseInt(args[++i]);
    } else if ((args[i] === '--host' || args[i] === '-h') && args[i + 1]) {
      opts.host = args[++i];
    } else if (args[i] === '--help') {
      console.log([
        '',
        'sardine-launch — SARdine server for NISAR On-Demand',
        '',
        'Usage:',
        '  node server/launch.js [options]',
        '',
        'Options:',
        '  --data-dir, -d <path>   Data directory to serve (default: /data/nisar)',
        '  --port, -p <number>     Port number (default: 8050)',
        '  --host <address>        Bind address (default: 0.0.0.0)',
        '  --help                  Show this help',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

// ─── MIME types ──────────────────────────────────────────────────────────
var MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
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
  var full = path.normalize(path.join(base, requested));
  if (full.indexOf(base) !== 0) return null; // traversal attempt
  return full;
}

// ─── File listing API ────────────────────────────────────────────────────
function handleFileList(dataDir, reqUrl, res) {
  var parsed = url.parse(reqUrl, true);
  var prefix = parsed.query.prefix || '';

  var dirPath = safePath(dataDir, prefix);
  if (!dirPath) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  fs.readdir(dirPath, { withFileTypes: true }, function (err, entries) {
    if (err) {
      var code = err.code === 'ENOENT' ? 404 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.code === 'ENOENT' ? 'Directory not found' : err.message }));
      return;
    }

    var directories = [];
    var files = [];
    var pending = 0;
    var done = false;

    function finish() {
      if (done) return;
      done = true;
      directories.sort();
      files.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });

      var body = JSON.stringify({
        directories: directories,
        files: files,
        isTruncated: false,
        nextToken: null,
        prefix: prefix,
        totalKeys: directories.length + files.length,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    }

    if (!entries || entries.length === 0) {
      finish();
      return;
    }

    entries.forEach(function (entry) {
      // Skip hidden files
      if (entry.name.charAt(0) === '.') return;

      var entryPrefix = prefix ? prefix.replace(/\/$/, '') + '/' + entry.name : entry.name;

      if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        directories.push(entryPrefix + '/');
      } else if (typeof entry.isFile === 'function' && entry.isFile()) {
        pending++;
        fs.stat(path.join(dirPath, entry.name), function (err2, fileStat) {
          if (!err2 && fileStat) {
            files.push({
              key: entryPrefix,
              size: fileStat.size,
              lastModified: fileStat.mtime.toISOString(),
              etag: '',
            });
          }
          pending--;
          if (pending === 0) finish();
        });
      }
    });

    // If no files needed stat, finish immediately
    if (pending === 0) finish();
  });
}

// ─── Data file serving (with Range support for h5chunk) ──────────────────
function handleDataFile(dataDir, filePath, req, res) {
  var fullPath = safePath(dataDir, filePath);
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, function (err, fileStat) {
    if (err || !fileStat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    var ext = path.extname(fullPath).toLowerCase();
    var contentType = MIME[ext] || 'application/octet-stream';
    var fileSize = fileStat.size;

    // Handle Range requests (critical for h5chunk streaming)
    var range = req.headers.range;
    if (range) {
      var match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + fileSize });
        res.end();
        return;
      }

      const start = parseInt(match[1], 10);
      let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        res.end();
        return;
      }

      // Clamp end to file size — browsers and h5chunk may request beyond EOF
      if (end >= fileSize) {
        end = fileSize - 1;
      }

      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      });
      fs.createReadStream(fullPath, { start: start, end: end }).pipe(res);
    } else {
      // Full file
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      });
      fs.createReadStream(fullPath).pipe(res);
    }
  });
}

// ─── Static file serving (dist/) ────────────────────────────────────────
function handleStatic(urlPath, res) {
  // Map / → /index.html
  var filePath = urlPath === '/' ? '/index.html' : urlPath;

  var fullPath = safePath(DIST_DIR, filePath);
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, function (err, fileStat) {
    if (!err && fileStat.isFile()) {
      var ext = path.extname(fullPath).toLowerCase();
      var contentType = MIME[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileStat.size,
        'Cache-Control': filePath.indexOf('/assets/') === 0
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
      fs.createReadStream(fullPath).pipe(res);
    } else {
      // SPA fallback — serve index.html for unknown routes
      var indexPath = path.join(DIST_DIR, 'index.html');
      fs.stat(indexPath, function (err2, indexStat) {
        if (!err2 && indexStat) {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': indexStat.size });
          fs.createReadStream(indexPath).pipe(res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
    }
  });
}

// ─── Main server ─────────────────────────────────────────────────────────
function main() {
  var opts = parseArgs();

  // Verify data directory exists
  var R_OK = (fs.constants && fs.constants.R_OK) || fs.R_OK || 4;
  try {
    fs.accessSync(opts.dataDir, R_OK);
  } catch (e) {
    console.warn('Warning: Data directory not found: ' + opts.dataDir);
    console.warn('  Server will start but /api/files and /data/ will return errors.');
    console.warn('  Use --data-dir to point to your NISAR data.\n');
  }

  // Verify dist exists
  var indexHtml = path.join(DIST_DIR, 'index.html');
  try {
    fs.accessSync(indexHtml, R_OK);
  } catch (e) {
    console.error('Error: Built frontend not found at ' + indexHtml);
    console.error('  Run "npm run build" on a machine with Node >= 16, then copy dist/ here.\n');
    process.exit(1);
  }

  var server = http.createServer(function (req, res) {
    var reqUrl = req.url;

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
      if (reqUrl.indexOf('/api/files') === 0) {
        handleFileList(opts.dataDir, reqUrl, res);
      } else if (reqUrl.indexOf('/data/') === 0) {
        var dataPath = decodeURIComponent(reqUrl.slice('/data/'.length));
        handleDataFile(opts.dataDir, dataPath, req, res);
      } else {
        var urlPath = decodeURIComponent(reqUrl.split('?')[0]);
        handleStatic(urlPath, res);
      }
    } catch (e) {
      console.error('Error handling ' + reqUrl + ':', e);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  var displayHost = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
  var localUrl = 'http://' + displayHost + ':' + opts.port;

  // Detect JupyterHub environment for useful proxy URL
  var jupyterUser = process.env.JUPYTERHUB_USER;
  var jupyterBase = process.env.JUPYTERHUB_BASE_URL || '';
  var jupyterHost = process.env.JUPYTERHUB_HOST || process.env.JUPYTERHUB_URL || '';
  var proxyUrl = null;
  if (jupyterUser) {
    // JupyterHub proxy URL: {host}{base}user/{user}/proxy/{port}/
    var base = jupyterBase.replace(/\/+$/, '');
    proxyUrl = jupyterHost + base + '/user/' + jupyterUser + '/proxy/' + opts.port + '/';
  }

  server.listen(opts.port, opts.host, function () {
    console.log('');
    console.log('  SARdine server running');
    console.log('  ─────────────────────────────────────────');
    console.log('  Local:     ' + localUrl);
    if (proxyUrl) {
      console.log('  Proxy:     ' + proxyUrl);
    }
    console.log('  Data dir:  ' + opts.dataDir);
    console.log('');
    console.log('  Routes:');
    console.log('    /              SARdine UI');
    console.log('    /api/files     directory listing API');
    console.log('    /data/<path>   file serving (Range OK)');
    console.log('');
    if (proxyUrl) {
      console.log('  Open in browser: ' + proxyUrl);
    } else {
      console.log('  Open in browser: ' + localUrl);
    }
    console.log('  Press Ctrl+C to stop');
    console.log('');
  });
}

main();

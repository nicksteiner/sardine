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
var https = require('https');
var fs   = require('fs');
var path = require('path');
var url  = require('url');
var crypto = require('crypto');

var DIST_DIR = path.resolve(__dirname, '..', 'dist');

// ─── CLI args ────────────────────────────────────────────────────────────
function parseArgs() {
  var args = process.argv.slice(2);
  var opts = {
    dataDir: '/data/nisar',
    port: 8050,
    host: '0.0.0.0',
    stacDb: process.env.STAC_DB_PATH || null,
    titilerUrl: process.env.TITILER_URL || null,
  };

  for (var i = 0; i < args.length; i++) {
    if ((args[i] === '--data-dir' || args[i] === '-d') && args[i + 1]) {
      opts.dataDir = path.resolve(args[++i]);
    } else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      opts.port = parseInt(args[++i]);
    } else if ((args[i] === '--host' || args[i] === '-h') && args[i + 1]) {
      opts.host = args[++i];
    } else if (args[i] === '--stac-db' && args[i + 1]) {
      opts.stacDb = path.resolve(args[++i]);
    } else if (args[i] === '--titiler-url' && args[i + 1]) {
      opts.titilerUrl = args[++i];
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
        '  --stac-db <path>        DuckDB STAC catalog database (enables /api/stac)',
        '  --titiler-url <url>     Titiler tile server URL (e.g. http://localhost:8100)',
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

// ─── S3 Presigning (server-side, credentials from env) ──────────────────
/**
 * Generate AWS S3 pre-signed URL using Signature Version 4.
 * Credentials are read from environment variables (never sent to client).
 *
 * POST /api/presign
 * Body: { bucket, key, region?, expires? }
 * Returns: { url: "https://..." } or { error: "..." }
 */
function handlePresignRequest(req, res) {
  // Only POST is allowed
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  // Read AWS credentials from environment
  var accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  var sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Server-side AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
    }));
    return;
  }

  // Parse request body
  var body = '';
  req.on('data', function(chunk) {
    body += chunk.toString();
    // Prevent DoS: limit body size to 10KB
    if (body.length > 10000) {
      req.connection.destroy();
    }
  });

  req.on('end', function() {
    try {
      var params = JSON.parse(body);
      var bucket = params.bucket;
      var key = params.key;
      var region = params.region || process.env.AWS_REGION || 'us-west-2';
      var expires = params.expires || 3600; // 1 hour default

      if (!bucket || !key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required parameters: bucket, key' }));
        return;
      }

      // Generate presigned URL
      var presignedUrl = generatePresignedUrl({
        bucket: bucket,
        key: key,
        region: region,
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
        sessionToken: sessionToken,
        expires: expires
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ url: presignedUrl }));

    } catch (e) {
      console.error('Error generating presigned URL:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate presigned URL: ' + e.message }));
    }
  });
}

/**
 * AWS Signature Version 4 signing implementation.
 * Pure Node.js built-ins (crypto module), zero dependencies.
 */
function generatePresignedUrl(opts) {
  var bucket = opts.bucket;
  var key = opts.key;
  var region = opts.region;
  var accessKeyId = opts.accessKeyId;
  var secretAccessKey = opts.secretAccessKey;
  var sessionToken = opts.sessionToken;
  var expires = opts.expires;
  var method = opts.method || 'GET';

  var service = 's3';
  var host = bucket + '.s3.' + region + '.amazonaws.com';
  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  var dateStamp = amzDate.slice(0, 8);
  var credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  var credential = accessKeyId + '/' + credentialScope;

  // Canonical URI: percent-encode each path segment
  var canonicalUri = '/' + key.split('/').map(encodeURIComponent).join('/');

  // Query parameters (sorted alphabetically)
  var params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  if (sessionToken) {
    params['X-Amz-Security-Token'] = sessionToken;
  }

  // Merge any extra query parameters (e.g. S3 API params for ListObjectsV2)
  var extraParams = opts.queryParams || {};
  var extraKeys = Object.keys(extraParams);
  for (var ep = 0; ep < extraKeys.length; ep++) {
    params[extraKeys[ep]] = extraParams[extraKeys[ep]];
  }

  var sortedKeys = Object.keys(params).sort();
  var canonicalQueryString = sortedKeys
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');

  // Canonical headers
  var canonicalHeaders = 'host:' + host + '\n';
  var signedHeaders = 'host';
  var payloadHash = 'UNSIGNED-PAYLOAD';

  // Canonical request
  var canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  // String to sign
  var canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  var stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  // Signing key derivation
  var kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(dateStamp).digest();
  var kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  var kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  var signingKey = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  // Signature
  var signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // Build final URL
  return 'https://' + host + canonicalUri + '?' + canonicalQueryString + '&X-Amz-Signature=' + signature;
}

// ─── S3 Bucket Listing (server-side, credentials from env) ───────────────

/**
 * Parse S3 ListObjectsV2 XML response using regex.
 * No DOMParser in Node.js, so we use simple regex extraction.
 * The ListObjectsV2 XML structure is well-defined and shallow.
 */
function parseS3ListXml(xml, requestedPrefix) {
  function getTagValue(str, tag) {
    var re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>');
    var m = str.match(re);
    return m ? m[1] : '';
  }
  function getAllBlocks(str, tag) {
    var re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g');
    var results = [];
    var m;
    while ((m = re.exec(str)) !== null) results.push(m[1]);
    return results;
  }

  // Check for S3 error response
  if (xml.indexOf('<Error>') >= 0) {
    var code = getTagValue(xml, 'Code');
    var message = getTagValue(xml, 'Message');
    throw new Error('S3 error: ' + code + ' — ' + message);
  }

  // Directories (CommonPrefixes > Prefix)
  var directories = [];
  var cpBlocks = getAllBlocks(xml, 'CommonPrefixes');
  cpBlocks.forEach(function(block) {
    var pfx = getTagValue(block, 'Prefix');
    if (pfx) directories.push(pfx);
  });

  // Files (Contents blocks)
  var files = [];
  var contentBlocks = getAllBlocks(xml, 'Contents');
  contentBlocks.forEach(function(block) {
    var key = getTagValue(block, 'Key');
    var size = parseInt(getTagValue(block, 'Size') || '0');
    var lastModified = getTagValue(block, 'LastModified');
    // Skip prefix itself and zero-byte directory markers
    if (key === requestedPrefix) return;
    if (key.charAt(key.length - 1) === '/' && size === 0) return;
    files.push({ key: key, size: size, lastModified: lastModified });
  });

  var isTruncated = getTagValue(xml, 'IsTruncated') === 'true';
  var nextToken = getTagValue(xml, 'NextContinuationToken') || null;

  return { directories: directories, files: files, isTruncated: isTruncated, nextToken: nextToken };
}

/**
 * List objects in an S3 bucket using a presigned ListObjectsV2 URL.
 * Uses the existing generatePresignedUrl() with extra query params.
 *
 * @param {Object} opts - bucket, prefix, delimiter, maxKeys, continuationToken, region, credentials
 * @param {function} callback - function(err, result)
 */
function s3ListObjects(opts, callback) {
  var queryParams = {
    'list-type': '2',
    'delimiter': opts.delimiter || '/',
    'max-keys': String(opts.maxKeys || 200),
  };
  if (opts.prefix) queryParams['prefix'] = opts.prefix;
  if (opts.continuationToken) queryParams['continuation-token'] = opts.continuationToken;

  var presignedListUrl = generatePresignedUrl({
    bucket: opts.bucket,
    key: '',
    region: opts.region,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    sessionToken: opts.sessionToken,
    expires: 300,
    queryParams: queryParams,
  });

  https.get(presignedListUrl, function(s3res) {
    var body = '';
    s3res.on('data', function(chunk) { body += chunk; });
    s3res.on('end', function() {
      if (s3res.statusCode !== 200) {
        callback(new Error('S3 ListObjects failed: HTTP ' + s3res.statusCode + ' — ' + body.substring(0, 500)));
        return;
      }
      try {
        var result = parseS3ListXml(body, opts.prefix || '');
        callback(null, result);
      } catch (e) {
        callback(e);
      }
    });
  }).on('error', function(e) {
    callback(e);
  });
}

/**
 * Handle POST /api/s3/list
 * Lists a private S3 bucket using server-side credentials and returns
 * pre-signed GET URLs for every file.
 *
 * Body: { bucket, prefix?, delimiter?, maxKeys?, continuationToken?, region?, presignExpires? }
 * Returns: { directories, files: [{key, size, lastModified, presignedUrl}], isTruncated, nextToken, prefix, bucket, region }
 */
function handleS3ListRequest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  var accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  var sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Server-side AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
    }));
    return;
  }

  var body = '';
  req.on('data', function(chunk) {
    body += chunk.toString();
    if (body.length > 10000) { req.connection.destroy(); }
  });

  req.on('end', function() {
    try {
      var params = JSON.parse(body);
      var bucket = params.bucket;
      if (!bucket) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required parameter: bucket' }));
        return;
      }

      var region = params.region || process.env.AWS_REGION || 'us-west-2';
      var prefix = params.prefix || '';
      var delimiter = params.delimiter || '/';
      var maxKeys = params.maxKeys || 200;
      var continuationToken = params.continuationToken || null;
      var presignExpires = params.presignExpires || 43200; // 12 hours default

      s3ListObjects({
        bucket: bucket,
        prefix: prefix,
        delimiter: delimiter,
        maxKeys: maxKeys,
        continuationToken: continuationToken,
        region: region,
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
        sessionToken: sessionToken,
      }, function(err, result) {
        if (err) {
          console.error('S3 list error:', err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'S3 listing failed: ' + err.message }));
          return;
        }

        // Generate presigned GET URLs for each file
        var filesWithUrls = result.files.map(function(f) {
          var presignedUrl = generatePresignedUrl({
            bucket: bucket,
            key: f.key,
            region: region,
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            sessionToken: sessionToken,
            expires: presignExpires,
          });
          return {
            key: f.key,
            size: f.size,
            lastModified: f.lastModified,
            presignedUrl: presignedUrl,
          };
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
          directories: result.directories,
          files: filesWithUrls,
          isTruncated: result.isTruncated,
          nextToken: result.nextToken,
          prefix: prefix,
          totalKeys: result.directories.length + filesWithUrls.length,
          bucket: bucket,
          region: region,
        }));
      });
    } catch (e) {
      console.error('Error in /api/s3/list:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to process request: ' + e.message }));
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

  // ─── Lazy STAC handler ─────────────────────────────────────────────────
  var stacHandler = null;
  if (opts.stacDb) {
    try {
      var stacApi = require('./stac-api.cjs');
      stacHandler = stacApi.createStacHandler(opts.stacDb);
      console.log('  STAC catalog enabled: ' + opts.stacDb);
    } catch (e) {
      console.warn('Warning: Could not load STAC API module: ' + e.message);
      console.warn('  Install duckdb-async for STAC support: npm install duckdb-async\n');
    }
  }

  var loggedProxyUrl = false;

  var server = http.createServer(function (req, res) {
    var reqUrl = req.url;

    // On first request, log the public proxy URL from the Host header
    if (!loggedProxyUrl && proxyPath && req.headers.host) {
      loggedProxyUrl = true;
      var proto = req.headers['x-forwarded-proto'] || 'https';
      var pubHost = req.headers['x-forwarded-host'] || req.headers.host;
      var fullUrl = proto + '://' + pubHost + proxyPath;
      console.log('  Public URL: ' + fullUrl);
      console.log('');
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      if (reqUrl.indexOf('/api/config') === 0) {
        // Server capability discovery endpoint
        var configBody = JSON.stringify({
          stac: !!stacHandler,
          titiler: opts.titilerUrl || null,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(configBody),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(configBody);
      } else if (reqUrl.indexOf('/api/stac') === 0 && stacHandler) {
        stacHandler(req, res);
      } else if (reqUrl.indexOf('/api/s3/list') === 0) {
        handleS3ListRequest(req, res);
      } else if (reqUrl.indexOf('/api/presign') === 0) {
        handlePresignRequest(req, res);
      } else if (reqUrl.indexOf('/api/files') === 0) {
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

  // Detect JupyterHub environment for proxy URL
  var jupyterUser = process.env.JUPYTERHUB_USER;
  var jupyterBase = (process.env.JUPYTERHUB_BASE_URL || '').replace(/\/+$/, '');
  var proxyPath = null;
  var proxyUrl = null;
  if (jupyterUser) {
    proxyPath = jupyterBase + '/user/' + jupyterUser + '/proxy/' + opts.port + '/';
    // Extract public hostname from OAuth callback URL
    // e.g. https://nisar.jpl.nasa.gov/ondemand/user/nsteiner/oauth_callback
    var callbackUrl = process.env.JUPYTERHUB_OAUTH_CALLBACK_URL
      || process.env.JUPYTERHUB_OAUTH_ACCESS_TOKEN_URL || '';
    var hostMatch = callbackUrl.match(/^(https?:\/\/[^\/]+)/);
    if (hostMatch) {
      proxyUrl = hostMatch[1] + proxyPath;
    }
  }

  server.listen(opts.port, opts.host, function () {
    console.log('');
    console.log('  SARdine server running');
    console.log('  ─────────────────────────────────────────');
    console.log('  Local:     ' + localUrl);
    if (proxyUrl) {
      console.log('  Proxy:     ' + proxyUrl);
    } else if (proxyPath) {
      console.log('  Proxy:     *' + proxyPath);
    }
    console.log('  Data dir:  ' + opts.dataDir);
    if (stacHandler) {
      console.log('  STAC DB:   ' + opts.stacDb);
    }
    if (opts.titilerUrl) {
      console.log('  Titiler:   ' + opts.titilerUrl);
    }
    console.log('');
    console.log('  Routes:');
    console.log('    /              SARdine UI');
    console.log('    /api/config    server capabilities');
    console.log('    /api/files     directory listing API');
    console.log('    /api/s3/list   S3 bucket listing with presigned URLs');
    console.log('    /api/presign   single-file presigned URL generation');
    if (stacHandler) {
      console.log('    /api/stac/*    STAC catalog search (DuckDB)');
    }
    console.log('    /data/<path>   file serving (Range OK)');
    console.log('');
    console.log('  Open in browser: ' + (proxyUrl || localUrl));
    console.log('  Press Ctrl+C to stop');
    console.log('');
  });
}

main();

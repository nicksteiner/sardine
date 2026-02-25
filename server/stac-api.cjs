#!/usr/bin/env node
/**
 * stac-api.cjs — DuckDB-backed STAC API for SARdine.
 *
 * Provides a thin STAC-compliant search endpoint over a DuckDB database
 * containing indexed STAC items (e.g., from stac-geoparquet or custom indexers).
 *
 * Compatible with Node.js >= 10 (CommonJS). Only dependency: duckdb-async (optional).
 *
 * Expected DB schema:
 *   CREATE TABLE items (
 *     id            VARCHAR,
 *     collection    VARCHAR,
 *     geometry      GEOMETRY,          -- WGS84 (EPSG:4326)
 *     datetime      TIMESTAMP,
 *     bbox          DOUBLE[4],         -- [west, south, east, north]
 *     properties    JSON,              -- Full STAC properties blob
 *     assets        JSON,              -- STAC assets object
 *     links         JSON               -- STAC links array (optional)
 *   );
 *
 * Usage:
 *   const { createStacHandler } = require('./stac-api.cjs');
 *   const handler = createStacHandler('/path/to/catalog.duckdb');
 *   // handler(req, res) handles /api/stac/* routes
 */

'use strict';

var path = require('path');

// ─── Lazy DuckDB connection ──────────────────────────────────────────────────

var _db = null;
var _dbPath = null;
var _initPromise = null;

function getDb(dbPath) {
  if (_db && _dbPath === dbPath) return Promise.resolve(_db);

  if (_initPromise && _dbPath === dbPath) return _initPromise;

  _dbPath = dbPath;
  _initPromise = initDb(dbPath);
  return _initPromise;
}

function initDb(dbPath) {
  var Database;
  try {
    Database = require('duckdb-async').Database;
  } catch (e) {
    return Promise.reject(new Error(
      'duckdb-async is not installed. Install it with: npm install duckdb-async'
    ));
  }

  return Database.create(dbPath).then(function (db) {
    // Install and load spatial extension for geometry queries
    return db.exec('INSTALL spatial; LOAD spatial;').then(function () {
      _db = db;
      console.log('[stac-api] DuckDB opened: ' + dbPath);
      return db;
    });
  });
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

function sendJson(res, code, data) {
  var body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/geo+json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { code: code, description: message });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 1048576) { // 1 MB limit
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJsonSafe(str) {
  if (!str) return null;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (e) { return str; }
}

// ─── Route: GET /api/stac (root catalog) ─────────────────────────────────────

function handleRoot(req, res, baseUrl) {
  sendJson(res, 200, {
    type: 'Catalog',
    id: 'sardine-local',
    title: 'SARdine Local Catalog',
    description: 'Local STAC catalog backed by DuckDB',
    stac_version: '1.0.0',
    conformsTo: [
      'https://api.stacspec.org/v1.0.0/core',
      'https://api.stacspec.org/v1.0.0/item-search',
    ],
    links: [
      { rel: 'self', href: baseUrl, type: 'application/json' },
      { rel: 'root', href: baseUrl, type: 'application/json' },
      { rel: 'search', href: baseUrl + '/search', type: 'application/geo+json', method: 'POST' },
      { rel: 'data', href: baseUrl + '/collections', type: 'application/json' },
    ],
  });
}

// ─── Route: GET /api/stac/collections ────────────────────────────────────────

function handleCollections(req, res, db, baseUrl) {
  var sql = [
    'SELECT',
    '  collection AS id,',
    '  collection AS title,',
    '  COUNT(*) AS item_count,',
    '  MIN(datetime) AS start_datetime,',
    '  MAX(datetime) AS end_datetime,',
    '  MIN(bbox[1]) AS min_west,',
    '  MIN(bbox[2]) AS min_south,',
    '  MAX(bbox[3]) AS max_east,',
    '  MAX(bbox[4]) AS max_north',
    'FROM items',
    'GROUP BY collection',
    'ORDER BY collection',
  ].join('\n');

  db.all(sql).then(function (rows) {
    var collections = rows.map(function (row) {
      var aggBbox = (isFinite(row.min_west) && isFinite(row.min_south))
        ? [row.min_west, row.min_south, row.max_east, row.max_north]
        : [-180, -90, 180, 90];

      return {
        type: 'Collection',
        id: row.id,
        title: row.title,
        description: row.item_count + ' items',
        stac_version: '1.0.0',
        license: 'proprietary',
        extent: {
          spatial: { bbox: [aggBbox] },
          temporal: { interval: [[row.start_datetime || null, row.end_datetime || null]] },
        },
        links: [
          { rel: 'self', href: baseUrl + '/collections/' + encodeURIComponent(row.id) },
          { rel: 'items', href: baseUrl + '/collections/' + encodeURIComponent(row.id) + '/items' },
        ],
      };
    });

    sendJson(res, 200, { collections: collections, links: [] });
  }).catch(function (err) {
    console.error('[stac-api] Collections query error:', err);
    sendError(res, 500, 'Database error: ' + err.message);
  });
}

// ─── Route: GET /api/stac/collections/:id ────────────────────────────────────

function handleCollectionById(req, res, db, baseUrl, collectionId) {
  var sql = [
    'SELECT',
    '  collection AS id,',
    '  COUNT(*) AS item_count,',
    '  MIN(datetime) AS start_datetime,',
    '  MAX(datetime) AS end_datetime',
    'FROM items',
    'WHERE collection = ?',
    'GROUP BY collection',
  ].join('\n');

  db.all(sql, collectionId).then(function (rows) {
    if (rows.length === 0) {
      sendError(res, 404, 'Collection not found: ' + collectionId);
      return;
    }

    var row = rows[0];
    sendJson(res, 200, {
      type: 'Collection',
      id: row.id,
      title: row.id,
      description: row.item_count + ' items',
      stac_version: '1.0.0',
      license: 'proprietary',
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [[row.start_datetime || null, row.end_datetime || null]] },
      },
      links: [
        { rel: 'self', href: baseUrl + '/collections/' + encodeURIComponent(row.id) },
        { rel: 'root', href: baseUrl },
        { rel: 'items', href: baseUrl + '/collections/' + encodeURIComponent(row.id) + '/items' },
      ],
    });
  }).catch(function (err) {
    console.error('[stac-api] Collection query error:', err);
    sendError(res, 500, 'Database error: ' + err.message);
  });
}

// ─── Route: POST /api/stac/search ────────────────────────────────────────────

function handleSearch(req, res, db, baseUrl, params) {
  var collections = params.collections || [];
  var bbox = params.bbox || null;
  var datetime = params.datetime || null;
  var limit = Math.min(Math.max(parseInt(params.limit) || 25, 1), 1000);
  var offset = parseInt(params.offset) || 0;
  var query = params.query || null;

  // Build SQL
  var conditions = [];
  var sqlParams = [];

  // Collection filter
  if (collections.length > 0) {
    var placeholders = collections.map(function () { return '?'; }).join(', ');
    conditions.push('collection IN (' + placeholders + ')');
    sqlParams = sqlParams.concat(collections);
  }

  // Bounding box — ST_Intersects with envelope
  if (bbox && bbox.length >= 4) {
    conditions.push(
      'ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))'
    );
    sqlParams.push(bbox[0], bbox[1], bbox[2], bbox[3]);
  }

  // Datetime interval
  if (datetime) {
    var dtParts = datetime.split('/');
    var dtStart = dtParts[0] && dtParts[0] !== '..' ? dtParts[0] : null;
    var dtEnd = dtParts[1] && dtParts[1] !== '..' ? dtParts[1] : null;

    if (dtStart && dtEnd) {
      conditions.push('datetime BETWEEN ?::TIMESTAMP AND ?::TIMESTAMP');
      sqlParams.push(dtStart, dtEnd);
    } else if (dtStart) {
      conditions.push('datetime >= ?::TIMESTAMP');
      sqlParams.push(dtStart);
    } else if (dtEnd) {
      conditions.push('datetime <= ?::TIMESTAMP');
      sqlParams.push(dtEnd);
    }
  }

  // Property query filters (e.g., {"sar:polarizations": {"eq": "HH"}})
  if (query) {
    Object.keys(query).forEach(function (prop) {
      var filter = query[prop];
      var safeProp = sanitizePropName(prop);
      if (filter.eq !== undefined) {
        conditions.push("json_extract_string(properties, '$." + safeProp + "') = ?");
        sqlParams.push(String(filter.eq));
      } else if (filter.gte !== undefined) {
        conditions.push("CAST(json_extract(properties, '$." + safeProp + "') AS DOUBLE) >= ?");
        sqlParams.push(filter.gte);
      } else if (filter.lte !== undefined) {
        conditions.push("CAST(json_extract(properties, '$." + safeProp + "') AS DOUBLE) <= ?");
        sqlParams.push(filter.lte);
      }
    });
  }

  var whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Count query (for numberMatched)
  var countSql = 'SELECT COUNT(*) AS cnt FROM items ' + whereClause;

  // Items query
  var itemsSql = [
    'SELECT id, collection, ST_AsGeoJSON(geometry) AS geojson,',
    '  datetime, bbox, properties, assets, links',
    'FROM items',
    whereClause,
    'ORDER BY datetime DESC',
    'LIMIT ? OFFSET ?',
  ].join('\n');

  var itemParams = sqlParams.concat([limit, offset]);

  // Run count and items in parallel
  Promise.all([
    db.all(countSql, sqlParams),
    db.all(itemsSql, itemParams),
  ]).then(function (results) {
    var countRow = results[0];
    var rows = results[1];
    var totalMatched = countRow[0] ? countRow[0].cnt : 0;

    var features = rows.map(function (row) {
      return rowToFeature(row);
    });

    // Build next link if there are more results
    var links = [
      { rel: 'self', href: baseUrl + '/search', type: 'application/geo+json' },
    ];
    if (offset + limit < totalMatched) {
      links.push({
        rel: 'next',
        href: baseUrl + '/search',
        type: 'application/geo+json',
        method: 'POST',
        body: Object.assign({}, params, { offset: offset + limit }),
      });
    }

    sendJson(res, 200, {
      type: 'FeatureCollection',
      features: features,
      numberMatched: totalMatched,
      numberReturned: features.length,
      links: links,
    });
  }).catch(function (err) {
    console.error('[stac-api] Search query error:', err);
    sendError(res, 500, 'Database error: ' + err.message);
  });
}

// ─── Row → STAC Feature ─────────────────────────────────────────────────────

function rowToFeature(row) {
  var geometry = null;
  try {
    geometry = JSON.parse(row.geojson);
  } catch (e) {
    geometry = null;
  }

  var properties = parseJsonSafe(row.properties) || {};
  var assets = parseJsonSafe(row.assets) || {};
  var links = parseJsonSafe(row.links) || [];
  var bbox = parseJsonSafe(row.bbox);

  // Ensure datetime is in properties
  if (row.datetime && !properties.datetime) {
    properties.datetime = row.datetime instanceof Date
      ? row.datetime.toISOString()
      : String(row.datetime);
  }

  var feature = {
    type: 'Feature',
    stac_version: '1.0.0',
    id: row.id,
    collection: row.collection,
    geometry: geometry,
    properties: properties,
    assets: assets,
    links: Array.isArray(links) ? links : [],
  };

  if (bbox) {
    feature.bbox = Array.isArray(bbox) ? bbox : [bbox];
  }

  return feature;
}

// ─── Security: sanitize JSON property path ───────────────────────────────────

function sanitizePropName(name) {
  // Only allow alphanumeric, underscore, colon, hyphen, dot
  return name.replace(/[^a-zA-Z0-9_:\-.]/g, '');
}

// ─── Main handler factory ────────────────────────────────────────────────────

/**
 * Create a request handler for STAC API routes.
 *
 * @param {string} dbPath - Path to DuckDB database file
 * @returns {function(req, res): void} HTTP request handler
 */
function createStacHandler(dbPath) {
  return function stacHandler(req, res) {
    // Parse URL
    var parsedUrl = require('url').parse(req.url, true);
    var pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/api/stac';

    // Base URL for links
    var proto = req.headers['x-forwarded-proto'] || 'http';
    var host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    var baseUrl = proto + '://' + host + '/api/stac';

    // Strip /api/stac prefix to get sub-route
    var subRoute = pathname.replace(/^\/api\/stac/, '') || '/';

    getDb(dbPath).then(function (db) {
      // Route: GET /api/stac
      if (subRoute === '/' && req.method === 'GET') {
        return handleRoot(req, res, baseUrl);
      }

      // Route: GET /api/stac/collections
      if (subRoute === '/collections' && req.method === 'GET') {
        return handleCollections(req, res, db, baseUrl);
      }

      // Route: GET /api/stac/collections/:id
      var collMatch = subRoute.match(/^\/collections\/([^/]+)$/);
      if (collMatch && req.method === 'GET') {
        return handleCollectionById(req, res, db, baseUrl, decodeURIComponent(collMatch[1]));
      }

      // Route: POST /api/stac/search
      if (subRoute === '/search' && req.method === 'POST') {
        return readBody(req).then(function (body) {
          var params = {};
          try { params = JSON.parse(body); } catch (e) { /* empty */ }
          return handleSearch(req, res, db, baseUrl, params);
        });
      }

      // Route: GET /api/stac/search (fallback)
      if (subRoute === '/search' && req.method === 'GET') {
        var q = parsedUrl.query;
        var params = {
          collections: q.collections ? q.collections.split(',') : undefined,
          bbox: q.bbox ? q.bbox.split(',').map(Number) : undefined,
          datetime: q.datetime || undefined,
          limit: q.limit ? parseInt(q.limit) : undefined,
          offset: q.offset ? parseInt(q.offset) : undefined,
        };
        return handleSearch(req, res, db, baseUrl, params);
      }

      // 404
      sendError(res, 404, 'Not found: ' + pathname);
    }).catch(function (err) {
      console.error('[stac-api] Handler error:', err);
      sendError(res, 500, err.message);
    });
  };
}

module.exports = { createStacHandler: createStacHandler };
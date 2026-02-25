# SARdine STAC Catalog Integration

SARdine can search a local STAC catalog backed by DuckDB. This enables scene discovery, spatial/temporal search, and footprint visualization — all without an external STAC server.

## How It Works

```
Indexer (external) → DuckDB/GeoParquet → sardine server → /api/stac/* → SARdine UI
```

1. **You** index your data into a DuckDB database (schema below)
2. **sardine-launch** serves a STAC-compliant API from that database
3. **SARdine UI** discovers the local catalog automatically and enables search

## Quick Start

```bash
# Start sardine with a STAC catalog
node server/launch.cjs --stac-db /path/to/catalog.duckdb --data-dir /path/to/data

# Or via environment variables
STAC_DB_PATH=/path/to/catalog.duckdb node server/launch.cjs
```

Open SARdine → select "Local Catalog" from the STAC endpoint dropdown → Connect → Search.

## DuckDB Schema

The STAC API expects an `items` table with this structure:

```sql
CREATE TABLE items (
  id            VARCHAR,          -- Unique STAC item ID
  collection    VARCHAR,          -- Collection name (e.g., "NISAR_L2_GCOV")
  geometry      GEOMETRY,         -- WGS84 footprint (EPSG:4326)
  datetime      TIMESTAMP,        -- Acquisition datetime
  bbox          DOUBLE[4],        -- Bounding box [west, south, east, north]
  properties    JSON,             -- Full STAC properties blob
  assets        JSON,             -- STAC assets object (URLs, media types)
  links         JSON              -- STAC links array (optional)
);

-- Recommended: install spatial extension for geometry queries
INSTALL spatial;
LOAD spatial;
```

### Properties JSON

The `properties` field should contain standard STAC and SAR extension fields:

```json
{
  "datetime": "2025-06-15T12:00:00Z",
  "sar:polarizations": ["HH", "HV"],
  "sar:frequency_band": "L",
  "sar:instrument_mode": "stripmap",
  "sat:orbit_state": "ascending",
  "platform": "NISAR"
}
```

### Assets JSON

The `assets` field maps asset keys to objects with `href` and `type`:

```json
{
  "data": {
    "href": "/data/nisar/NISAR_L2_GCOV_001_005_A_219_4020_HH_20250615.h5",
    "type": "application/x-hdf5",
    "title": "GCOV HDF5"
  },
  "cog": {
    "href": "https://example.com/tiles/scene.tif",
    "type": "image/tiff; application=geotiff; profile=cloud-optimized",
    "title": "Cloud Optimized GeoTIFF"
  }
}
```

Asset `href` can be:
- **Absolute paths** — served via sardine's `/data/` route
- **Relative paths** — resolved relative to the data directory
- **Full URLs** — loaded directly (COGs via HTTP Range, HDF5 via h5chunk)

## Indexing Your Data

You bring your own indexer. Here are some approaches:

### Option A: Direct SQL

```python
import duckdb

db = duckdb.connect("catalog.duckdb")
db.execute("INSTALL spatial; LOAD spatial;")
db.execute("""
  CREATE TABLE IF NOT EXISTS items (
    id VARCHAR, collection VARCHAR, geometry GEOMETRY,
    datetime TIMESTAMP, bbox DOUBLE[4],
    properties JSON, assets JSON, links JSON
  )
""")

# Insert items
db.execute("""
  INSERT INTO items VALUES (
    'scene_001',
    'MY_SAR_COLLECTION',
    ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[...]]]}'),
    '2025-06-15T12:00:00',
    [-122.5, 37.0, -121.5, 38.0],
    '{"datetime":"2025-06-15T12:00:00Z","platform":"SAR"}',
    '{"data":{"href":"/data/scene_001.h5","type":"application/x-hdf5"}}',
    '[]'
  )
""")
```

### Option B: From stac-geoparquet

```python
import duckdb

db = duckdb.connect("catalog.duckdb")
db.execute("INSTALL spatial; LOAD spatial;")

# Load a STAC GeoParquet file directly
db.execute("""
  CREATE TABLE items AS
  SELECT * FROM read_parquet('my_catalog.parquet')
""")
```

### Option C: From existing STAC API

```python
import duckdb
import requests

db = duckdb.connect("catalog.duckdb")
db.execute("INSTALL spatial; LOAD spatial;")

# Fetch items from an existing STAC API and insert
resp = requests.post("https://stac-api.example.com/search", json={
    "collections": ["my-collection"],
    "limit": 100,
})
for item in resp.json()["features"]:
    db.execute("INSERT INTO items VALUES (?, ?, ST_GeomFromGeoJSON(?), ?, ?, ?, ?, ?)", [
        item["id"],
        item["collection"],
        json.dumps(item["geometry"]),
        item["properties"]["datetime"],
        item["bbox"],
        json.dumps(item["properties"]),
        json.dumps(item["assets"]),
        json.dumps(item.get("links", [])),
    ])
```

## API Endpoints

When `STAC_DB_PATH` is set, the server exposes:

| Endpoint | Method | Description |
|:---------|:-------|:------------|
| `/api/config` | GET | Server capabilities (`{ stac: true/false, titiler: url }`) |
| `/api/stac` | GET | Root catalog |
| `/api/stac/collections` | GET | List all collections |
| `/api/stac/collections/:id` | GET | Single collection |
| `/api/stac/search` | POST | STAC Item search |
| `/api/stac/search` | GET | STAC Item search (query params) |

### Search Parameters (POST body)

```json
{
  "collections": ["NISAR_L2_GCOV"],
  "bbox": [-123, 36, -121, 38],
  "datetime": "2025-01-01T00:00:00Z/2025-12-31T23:59:59Z",
  "limit": 25,
  "offset": 0,
  "query": {
    "sar:polarizations": { "eq": "HH" }
  }
}
```

## Serving Data from Private S3 Buckets

When STAC items reference files in private S3 buckets, the sardine server can generate pre-signed URLs server-side so the browser can stream them directly. AWS credentials never leave the server.

### Architecture

```
Browser → sardine /api/s3/list → S3 ListObjectsV2 (signed server-side)
                                    ↓
Browser ← { files: [{ key, presignedUrl }] }
                                    ↓
Browser → presignedUrl → S3 GetObject (Range requests for h5chunk/geotiff.js)
```

### Server Configuration

Set AWS credentials as environment variables on the sardine server:

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=secret...
export AWS_SESSION_TOKEN=token...   # optional — for temporary/STS credentials
export AWS_REGION=us-west-2         # default region
```

These work with IAM user keys, EC2 instance profiles (via STS), ECS task roles, or any credential chain that produces the standard `AWS_*` env vars.

### S3 API Endpoints

These endpoints are always available when AWS credentials are configured — they do not require `STAC_DB_PATH`.

| Endpoint | Method | Description |
|:---------|:-------|:------------|
| `/api/s3/list` | POST | Browse a private S3 bucket; returns directory listing + pre-signed GET URLs for each file |
| `/api/presign` | POST | Generate a single pre-signed GET URL for one S3 object |

### Browsing a Private Bucket

**`POST /api/s3/list`**

```bash
curl -X POST http://localhost:8050/api/s3/list \
  -H "Content-Type: application/json" \
  -d '{
    "bucket": "my-sar-data",
    "prefix": "L2_GCOV/",
    "region": "us-west-2"
  }'
```

Response:

```json
{
  "directories": ["L2_GCOV/2025/"],
  "files": [
    {
      "key": "L2_GCOV/NISAR_L2_GCOV_001.h5",
      "size": 1073741824,
      "lastModified": "2025-06-15T12:00:00.000Z",
      "presignedUrl": "https://my-sar-data.s3.us-west-2.amazonaws.com/L2_GCOV/..."
    }
  ],
  "isTruncated": false,
  "nextToken": null,
  "prefix": "L2_GCOV/",
  "bucket": "my-sar-data",
  "region": "us-west-2"
}
```

Each `presignedUrl` supports HTTP Range requests, so h5chunk and geotiff.js can stream chunks directly from S3 without downloading the full file.

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `bucket` | string | *(required)* | S3 bucket name |
| `prefix` | string | `""` | Key prefix (e.g. `"L2_GCOV/"`) |
| `delimiter` | string | `"/"` | Directory grouping delimiter |
| `maxKeys` | number | `200` | Max objects per page |
| `continuationToken` | string | `null` | Pagination token from previous response |
| `region` | string | `$AWS_REGION` or `us-west-2` | AWS region |
| `presignExpires` | number | `43200` | Pre-signed URL lifetime in seconds (default 12 hours) |

### Generating a Single Pre-signed URL

**`POST /api/presign`**

```bash
curl -X POST http://localhost:8050/api/presign \
  -H "Content-Type: application/json" \
  -d '{
    "bucket": "my-sar-data",
    "key": "L2_GCOV/NISAR_L2_GCOV_001.h5",
    "region": "us-west-2",
    "expires": 3600
  }'
```

Response:

```json
{
  "url": "https://my-sar-data.s3.us-west-2.amazonaws.com/L2_GCOV/NISAR_L2_GCOV_001.h5?X-Amz-Algorithm=..."
}
```

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `bucket` | string | *(required)* | S3 bucket name |
| `key` | string | *(required)* | S3 object key |
| `region` | string | `$AWS_REGION` or `us-west-2` | AWS region |
| `expires` | number | `3600` | URL lifetime in seconds (default 1 hour) |

### STAC Catalog + S3

When combining the STAC catalog with S3-hosted data, store `s3://` URIs or direct presignable references in your STAC item assets:

```json
{
  "assets": {
    "data": {
      "href": "s3://my-sar-data/L2_GCOV/NISAR_L2_GCOV_001.h5",
      "type": "application/x-hdf5",
      "storage:platform": "aws",
      "storage:region": "us-west-2"
    }
  }
}
```

The frontend can resolve `s3://` hrefs to pre-signed URLs via `/api/presign` at load time, or your indexer can pre-generate presigned URLs when building the catalog (useful for short-lived catalogs).

### Security Notes

- AWS credentials are **never** sent to the browser — all signing happens server-side
- Pre-signed URLs are temporary (configurable expiry) and grant read-only GET access to specific objects
- Uses AWS Signature Version 4 — pure Node.js `crypto` module, zero external dependencies
- Supports temporary credentials via `AWS_SESSION_TOKEN` (EC2 instance profiles, ECS task roles, `aws sts assume-role`)

## Docker Compose with Titiler

For COG tile serving, add the titiler sidecar:

```bash
docker compose --profile stac up
```

This starts both `sardine` and `titiler`. Configure environment variables:

```yaml
# docker-compose.yml (sardine service)
environment:
  - STAC_DB_PATH=/data/catalog.duckdb
  - TITILER_URL=http://titiler:8000
  # For private S3 buckets:
  - AWS_ACCESS_KEY_ID=AKIA...
  - AWS_SECRET_ACCESS_KEY=secret...
  - AWS_REGION=us-west-2
```

## Environment Variables

| Variable | Description | Default |
|:---------|:------------|:--------|
| `STAC_DB_PATH` | Path to DuckDB catalog database | *(disabled)* |
| `TITILER_URL` | Titiler tile server URL | *(disabled)* |
| `AWS_ACCESS_KEY_ID` | AWS access key (enables S3 presigning + bucket listing) | *(disabled)* |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | *(disabled)* |
| `AWS_SESSION_TOKEN` | AWS session token (for temporary credentials) | *(optional)* |
| `AWS_REGION` | Default AWS region | `us-west-2` |

CLI equivalents: `--stac-db <path>`, `--titiler-url <url>`.

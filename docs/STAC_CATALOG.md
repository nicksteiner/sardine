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
```

## Environment Variables

| Variable | Description | Default |
|:---------|:------------|:--------|
| `STAC_DB_PATH` | Path to DuckDB catalog database | *(disabled)* |
| `TITILER_URL` | Titiler tile server URL | *(disabled)* |

CLI equivalents: `--stac-db <path>`, `--titiler-url <url>`.

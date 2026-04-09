# DEM Sources for SARdine

SARdine's DEM loader (`src/loaders/dem-loader.js`) supports two elevation data sources.

## Copernicus GLO-30 (Default)

**Type:** Digital Surface Model (DSM) — includes buildings and tree canopy  
**Resolution:** ~30 m (1 arc-second)  
**Coverage:** Global (±90° latitude)  
**Source:** [AWS Open Data](https://registry.opendata.aws/copernicus-dem/)  
**License:** Free and open (Copernicus license)

GLO-30 tiles are fetched on demand from AWS — no setup required. This is the fallback source when FABDEM is not available.

**Caveat:** Because GLO-30 is a DSM, it includes building rooftops and canopy heights. This biases SAR layover and dihedral predictions high in urban and forested areas.

## FABDEM V2 ()

**Type:** Digital Terrain Model (DTM) — bare-earth, buildings and canopy removed  
**Resolution:** ~30 m (1 arc-second)  
**Coverage:** Global (56°S to 80°N)  
**Source:** [Fathom / University of Bristol](https://www.fathom.global/product/global-terrain-data-fabdem/)  
**License:** CC BY-NC-SA 4.0

FABDEM V2 is preferred for SAR scene geometry because bare-earth elevations give correct layover and dihedral predictions in urban areas (GLO-30 double-counts building heights).

### Setup

FABDEM V2 is **not** available as a public tile server. You must download tiles from [data.bris](https://data.bris.ac.uk/data/) and mirror them locally or on an internal HTTPS endpoint.

1. **Download tiles** from the FABDEM V2 dataset on data.bris.  
   Tiles are 1°×1° GeoTIFFs named `{N|S}{lat:02d}{E|W}{lon:03d}_FABDEM_V2.tif`.

2. **Set the tile root** via environment variable:

   ```bash
   # Local directory (file:// URL)
   export DEM_FABDEM_V2_ROOT=file:///media/nsteiner/data4/fabdem-v2/

   # Or HTTPS mirror
   export DEM_FABDEM_V2_ROOT=https://internal-mirror.example.com/fabdem-v2/
   ```

   For Vite dev server, add to `.env.local`:
   ```
   VITE_DEM_FABDEM_V2_ROOT=file:///media/nsteiner/data4/fabdem-v2/
   ```

   Or set it at runtime in the browser console:
   ```javascript
   globalThis.__DEM_FABDEM_V2_ROOT = 'https://internal-mirror.example.com/fabdem-v2/';
   ```

3. **Verify** by running the integration test:
   ```bash
   DEM_FABDEM_V2_ROOT=file:///path/to/fabdem-v2/ node test/dem-loader-test.mjs
   ```

### Source Selection

| `source` param | Behavior |
|:---------------|:---------|
| `'glo30'` | Always use Copernicus GLO-30 (DSM) |
| `'fabdem-v2'` | Always use FABDEM V2 (errors if root not configured) |
| `'auto'` (default) | FABDEM V2 if configured, else GLO-30 with a warning |

## API

```javascript
import { loadDEM } from './loaders/dem-loader.js';

const dem = await loadDEM([west, south, east, north], { source: 'auto' });
// dem.sampleDEM(lat, lon)  → elevation in meters (bilinear interpolation)
// dem.source               → 'glo30' | 'fabdem-v2'
// dem.isBareEarth          → true for FABDEM, false for GLO-30
// dem.resolution           → ~0.000278° (~30 m)
// dem.bbox                 → input bounding box
```

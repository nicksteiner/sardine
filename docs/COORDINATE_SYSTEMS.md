# SARdine Coordinate System Reference

## The Four Coordinate Spaces

### 1. Image Pixel Space
- **Origin**: Top-left corner of the raster (row 0, col 0 = northwest corner)
- **X axis**: Column index, increases eastward → `[0, width)`
- **Y axis**: Row index, increases southward (downward) → `[0, height)`
- **Units**: Integer pixels
- **Used by**: `getExportStripe`, `readRegion`, `getPixelValue`, ROI `{left, top, width, height}`, chunk indexing

### 2. World Coordinate Space (CRS)
- **Origin**: Defined by the CRS (e.g., UTM zone origin or EPSG:4326 lon/lat)
- **X axis**: Easting (UTM meters) or longitude (degrees), increases eastward
- **Y axis**: Northing (UTM meters) or latitude (degrees), **increases northward** (opposite to image rows)
- **Units**: Meters (UTM) or degrees (lat/lon)
- **Used by**: `bounds`, `worldBounds`, GeoTIFF export bounds, deck.gl tile `bbox`, WKT ROI input

### 3. deck.gl World Space (OrthographicView)
- **Same as** World Coordinate Space — deck.gl positions geometry using world coordinates
- `OrthographicView({ flipY: false })`: **Y+ is up on screen** (matching northing/latitude)
- `viewState.target`: Center of viewport in world coordinates `[worldX, worldY]`
- `viewState.zoom`: `2^zoom` = screen pixels per world unit
- **Tile bbox convention**: `bbox.left/right` = world X range; `bbox.top` = min world Y (south); `bbox.bottom` = max world Y (north)

### 4. Screen Pixel Space (Canvas)
- **Origin**: Top-left corner of the HTML canvas
- **X axis**: Increases rightward → `[0, canvasWidth)`
- **Y axis**: Increases downward → `[0, canvasHeight)`
- **Units**: CSS pixels (multiply by `devicePixelRatio` for physical pixels)
- **Used by**: Mouse events, ROIOverlay canvas drawing, overlay positioning

## Conversion Functions

### World ↔ Screen (`geo-overlays.js`)

```
worldToPixel(wx, wy, viewState, canvasW, canvasH)
  screenX =  (wx - target[0]) * 2^zoom + canvasW/2
  screenY = -(wy - target[1]) * 2^zoom + canvasH/2   ← Y negated

pixelToWorld(px, py, viewState, canvasW, canvasH)
  worldX =  (px - canvasW/2) / 2^zoom + target[0]
  worldY = -(py - canvasH/2) / 2^zoom + target[1]    ← Y negated
```

**Note**: deck.gl `OrthographicView` with `flipY: false` uses standard GL convention: world Y+ is **up** on screen. But HTML canvas screen Y+ is **down**. The Y-negation in `worldToPixel`/`pixelToWorld` bridges this mismatch so overlays (ROI, classification, scale bar) align with deck.gl's rendered tiles.

### Image Pixel ↔ World

```
worldX = bounds[0] + (col / width) * (bounds[2] - bounds[0])
worldY = bounds[3] - (row / height) * (bounds[3] - bounds[1])
                 ↑ Y-flip: row 0 = north = maxY

col = (worldX - bounds[0]) / (bounds[2] - bounds[0]) * width
row = (bounds[3] - worldY) / (bounds[3] - bounds[1]) * height
         ↑ Y-flip: larger worldY → smaller row
```

### Tile bbox → Image Pixel (inside getTile)

```
pxLeft  = ((bbox.left - bounds[0]) / spanX) * width
pxRight = ((bbox.right - bounds[0]) / spanX) * width
pxTop   = ((bounds[3] - bbox.bottom) / spanY) * height   // bbox.bottom = max worldY = north
pxBottom = ((bounds[3] - bbox.top) / spanY) * height      // bbox.top = min worldY = south
```

## `bounds` Contract

**All loaders return `bounds` in world coordinates.**

| Loader | `bounds` | `worldBounds` |
|--------|----------|---------------|
| `loadNISARGCOVStreaming` | World coords (UTM/latlon) | World coords (same) |
| `loadNISARGCOV` (h5wasm) | World coords | World coords (same) |
| `loadNISARGCOVFromUrl` | World coords | World coords (same) |
| `loadNISARRGBComposite` | World coords | World coords (same) |
| `loadCOG` | World coords | N/A |

**Fallback**: If no coordinate arrays exist in the file, bounds fall back to `[0, 0, width, height]` (pixel space). In this case the world-to-pixel conversion is an identity transform.

`bounds` is used for:
- deck.gl layer positioning (`extent: bounds`, SARGPULayer quad geometry)
- View initialization (`viewState.target = center of bounds`)
- Tile bbox ↔ pixel conversion in `getTile`
- ROIOverlay `imgToScreen` / `screenToImagePixels`
- Histogram region calculation

`worldBounds` is used for:
- GeoTIFF export georeferencing (`geoBounds = worldBounds || bounds`)
- WKT ROI intersection checking

Since `bounds === worldBounds` for all loaders with valid coordinates, these are interchangeable.

## ROI Coordinates

The ROI `{left, top, width, height}` is always in **image pixel space**:
- `left`: Starting column (0 = west edge)
- `top`: Starting row (0 = north edge)
- `width`: Number of columns
- `height`: Number of rows

ROI is created by `ROIOverlay.screenToImagePixels`: screen → world → image pixel.
ROI is rendered by `ROIOverlay.imgToScreen`: image pixel → world → screen.

For histogram sampling, ROI pixel coords are converted to world coords before passing to `getTile`:
```
roiWorldLeft  = bounds[0] + (roi.left / width) * (bounds[2] - bounds[0])
roiWorldTop   = bounds[3] - ((roi.top + roi.height) / height) * (bounds[3] - bounds[1])
```

## Export Coordinates

`getExportStripe` operates entirely in **image pixel space** (startRow, startCol, numRows, numCols). Geographic bounds for the exported GeoTIFF are computed separately in `main.jsx` using `worldBounds`:

```
nativeSpacingX = (worldBounds[2] - worldBounds[0]) / (sourceWidth - 1)
exportBounds = [originX - spacing/2, ..., originX + exportW*ml*spacing]
```

The half-pixel shift converts from pixel-center (NISAR convention) to pixel-edge (GeoTIFF PixelIsArea convention).

## Mosaicing Implications

Because all loaders now use world-coordinate bounds, multiple NISAR granules loaded into the same `OrthographicView` will be positioned correctly in geographic space. Adjacent swaths sharing a UTM zone will tile naturally — their `bounds` encode real-world positions, not overlapping `[0,0,W,H]` pixel ranges.

For multi-granule mosaicing to work:
1. All granules must share the same CRS (or be reprojected)
2. The `OrthographicView` extent should encompass all granule bounds
3. Each granule's `getTile` independently converts world-coord bboxes to its own pixel space

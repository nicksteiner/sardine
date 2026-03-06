#!/usr/bin/env bash
# Convert all GeoTIFFs in a folder to Cloud Optimized GeoTIFFs (COGs)
# Reprojects to the appropriate UTM zone based on each file's center coordinate.
#
# Usage: ./tif2cog.sh <input_dir> [output_dir]
#
# Requires: GDAL (gdal_translate, gdalinfo, gdalwarp)
# If output_dir is omitted, COGs are written alongside originals with _cog suffix.

set -euo pipefail

INPUT_DIR="${1:?Usage: $0 <input_dir> [output_dir]}"
OUTPUT_DIR="${2:-}"

for cmd in gdal_translate gdalinfo gdalwarp; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd not found. Install GDAL first." >&2
        exit 1
    fi
done

# Determine UTM EPSG code from a file's center lon/lat
# Handles: georeferenced files (wgs84Extent) and GCP-only files (gcpList)
get_utm_epsg() {
    local file="$1"
    local result
    result="$(gdalinfo -json "$file" 2>/dev/null \
        | python3 -c "
import sys, json
info = json.load(sys.stdin)

# Try wgs84Extent first (georeferenced files)
corners = info.get('wgs84Extent', {}).get('coordinates', [[]])[0]
if corners:
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
else:
    # Fall back to GCPs (e.g. ICEYE GRD with ground control points)
    gcps = info.get('gcps', {}).get('gcpList', [])
    if not gcps:
        sys.exit(1)
    lons = [g['x'] for g in gcps]
    lats = [g['y'] for g in gcps]

clon = (min(lons) + max(lons)) / 2
clat = (min(lats) + max(lats)) / 2
zone = int((clon + 180) / 6) + 1
epsg = 32600 + zone if clat >= 0 else 32700 + zone
print(epsg)
")" || return 1
    echo "$result"
}

shopt -s nullglob nocaseglob
files=("$INPUT_DIR"/*.tif "$INPUT_DIR"/*.tiff)
shopt -u nullglob nocaseglob

if [ ${#files[@]} -eq 0 ]; then
    echo "No .tif/.tiff files found in $INPUT_DIR" >&2
    exit 1
fi

if [ -n "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"
fi

echo "Converting ${#files[@]} file(s) to COG..."

for f in "${files[@]}"; do
    base="$(basename "${f%.*}")"
    if [ -n "$OUTPUT_DIR" ]; then
        out="$OUTPUT_DIR/${base}_cog.tif"
    else
        out="$INPUT_DIR/${base}_cog.tif"
    fi

    # Detect UTM zone from file extent
    utm_epsg="$(get_utm_epsg "$f")" || true
    if [ -z "$utm_epsg" ]; then
        echo "  WARNING: Could not determine UTM zone for $f, skipping reproject" >&2
        echo "  $f -> $out (no reproject)"
        gdal_translate "$f" "$out" \
            -of COG \
            -co COMPRESS=DEFLATE \
            -co PREDICTOR=2 \
            -co OVERVIEWS=AUTO \
            -co BLOCKSIZE=512 \
            -co RESAMPLING=AVERAGE
    else
        echo "  $f -> $out (EPSG:$utm_epsg)"
        tmp_warp="$(mktemp --suffix=.tif)"
        gdalwarp "$f" "$tmp_warp" \
            -t_srs "EPSG:$utm_epsg" \
            -r bilinear \
            -overwrite
        gdal_translate "$tmp_warp" "$out" \
            -of COG \
            -co COMPRESS=DEFLATE \
            -co PREDICTOR=2 \
            -co OVERVIEWS=AUTO \
            -co BLOCKSIZE=512 \
            -co RESAMPLING=AVERAGE
        rm -f "$tmp_warp"
    fi
done

echo "Done."
